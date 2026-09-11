import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { zDocumentType } from "@invex/core";
import type { AppConfig } from "../config";
import type { MachineHealth } from "../pipeline/machine";
import type { Db } from "../db/client";
import {
  findReusableByHash,
  getDocument,
  getPdf,
  getTrace,
  insertDocument,
  listDocuments,
} from "../db/repos/documents";
import type { DocumentRow } from "../db/repos/documents";
import { listEscalations } from "../db/repos/escalations";
import { getTemplate, listTemplates } from "../db/repos/templates";
import type { DocumentStatus } from "../db/schema";
import { UUID_RE, zEscalationQuery, zLimitQuery } from "./params";
import { registerReviewRoutes } from "./review";
import { sql } from "drizzle-orm";

export interface AppDeps {
  db: Db;
  config: AppConfig;
  log?: Logger;
  /**
   * Worker liveness probe. Without it /health cannot answer the question that
   * actually matters in a single-replica deployment — docs/deployment.md lists
   * "documents pile up while /health returns ok" as its first troubleshooting
   * row and calls it structurally undetectable (INVEX-009).
   */
  worker?: () => MachineHealth;
}

const DOCUMENT_STATUSES: DocumentStatus[] = [
  "received",
  "routed",
  "extracted",
  "escalated_vlm",
  "pending_review",
  "committed",
  "exported_markdown",
  "segmented",
  "failed",
];

/**
 * `force` skips the content-hash reuse below.
 *
 * Dedup is silent and the pipeline is not idempotent in the direction that
 * matters: a document processed by an older build keeps that build's verdict
 * forever, and re-uploading the same PDF returns that row without running
 * anything. Re-testing a fix against a real document meant deleting rows out of
 * Postgres by hand. `content_hash` is a plain index, not a unique constraint —
 * findReusableByHash already orders by createdAt DESC because duplicates are an
 * expected shape — so a second row for the same bytes needs no schema change.
 */
const zIngestQuery = z.object({
  force: z.enum(["true", "false"]).optional(),
});

interface IngestResult {
  documentId: string;
  filename: string;
  deduplicated: boolean;
  /** When the reused row was last written — present only when deduplicated. */
  deduplicatedAt?: string;
}

const zListQuery = z.object({
  status: z.enum(DOCUMENT_STATUSES as [DocumentStatus, ...DocumentStatus[]]).optional(),
  documentType: zDocumentType.optional(),
  /** The point of the flag: "committed AND actually checked" is one query. */
  arithmeticVerified: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/** Public projection of a document row (blobs and bulky payloads stripped). */
function toSummary(doc: DocumentRow) {
  return {
    id: doc.id,
    parentId: doc.parentId,
    filename: doc.filename,
    status: doc.status,
    route: doc.route,
    /** Which document class this is — invoice, orderConfirmation, ... (null until classified). */
    documentType: doc.documentType,
    /**
     * Did the document's own numbers corroborate each other? Null until
     * reconciled; false on a committed document means there was nothing to
     * check, not that a check failed.
     */
    arithmeticVerified: doc.arithmeticVerified,
    segmentPages: doc.segmentPages,
    error: doc.error,
    attempts: doc.attempts,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toDetail(doc: DocumentRow) {
  return {
    ...toSummary(doc),
    classifier: doc.classifier,
    candidate: doc.candidate,
    result: doc.result,
    repairs: doc.repairs,
    violations: doc.violations,
    vlmAttempted: doc.vlmAttempted,
    contentHash: doc.contentHash,
  };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { db, config } = deps;
  // pino's Logger satisfies FastifyBaseLogger structurally; the cast keeps the
  // instance on Fastify's default generics instead of specializing them.
  const app = Fastify(
    deps.log
      ? { loggerInstance: deps.log as unknown as FastifyBaseLogger }
      : { logger: false },
  );

  void app.register(multipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 50 },
  });

  app.post("/api/ingest", async (req, reply) => {
    const query = zIngestQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: query.error.message });
    const force = query.data.force === "true";

    const results: IngestResult[] = [];
    for await (const part of req.parts()) {
      if (part.type !== "file") continue;
      const buf = await part.toBuffer();
      if (buf.length === 0) continue;
      const contentHash = createHash("sha256").update(buf).digest("hex");
      const filename = part.filename || "upload.pdf";
      const existing = force ? null : await findReusableByHash(db, contentHash);
      if (existing) {
        results.push({
          documentId: existing.id,
          filename,
          deduplicated: true,
          // When that row was last WRITTEN, not when it was returned. Without
          // it a week-old verdict and a fresh one are indistinguishable to the
          // caller, which is exactly how a stale result gets read as a new one.
          deduplicatedAt: existing.updatedAt.toISOString(),
        });
        continue;
      }
      const doc = await insertDocument(db, { filename, contentHash, pdf: buf });
      results.push({ documentId: doc.id, filename, deduplicated: false });
    }
    if (results.length === 0) {
      return reply.code(400).send({ error: "no PDF file parts in request" });
    }
    return reply.code(202).send(results);
  });

  app.get("/api/documents", async (req, reply) => {
    const parsed = zListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const rows = await listDocuments(db, parsed.data);
    return rows.map(toSummary);
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "invalid document id" });
    const doc = await getDocument(db, req.params.id);
    if (!doc) return reply.code(404).send({ error: "not found" });
    return toDetail(doc);
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id/pdf", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "invalid document id" });
    const pdf = await getPdf(db, req.params.id);
    if (!pdf) return reply.code(404).send({ error: "not found" });
    return reply
      .type("application/pdf")
      .header("content-disposition", "inline")
      .send(Buffer.from(pdf));
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id/markdown", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "invalid document id" });
    const doc = await getDocument(db, req.params.id);
    if (!doc) return reply.code(404).send({ error: "not found" });
    if (doc.markdown === null) return reply.code(404).send({ error: "document has no markdown export" });
    return {
      documentId: doc.id,
      // classification is the classifier BAND and keeps its three documented
      // values; documentType is the separate class axis, sibling not override.
      classification: (doc.classifier as { band?: string } | null)?.band ?? null,
      documentType: doc.documentType,
      markdown: doc.markdown,
    };
  });

  /** The full path a document took through the pipeline (+ children if segmented). */
  app.get<{ Params: { id: string } }>("/api/documents/:id/trace", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "invalid document id" });
    const doc = await getDocument(db, req.params.id);
    if (!doc) return reply.code(404).send({ error: "not found" });
    const events = await getTrace(db, req.params.id);
    return {
      document: toSummary(doc),
      events: events.map((e) => ({
        documentId: e.documentId,
        event: e.event,
        detail: e.detail,
        at: e.at,
      })),
    };
  });

  registerReviewRoutes(app, db);

  app.get("/api/templates", async (req, reply) => {
    const q = zLimitQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid limit" });
    const rows = await listTemplates(db, q.data.limit);
    return rows.map((t) => ({
      id: t.id,
      ustIdNr: t.ustIdNr,
      steuernummer: t.steuernummer,
      nameHash: t.nameHash,
      version: t.version,
      source: t.source,
      updatedAt: t.updatedAt,
      displayName: (t.template as { vendorIds?: { displayName?: string } }).vendorIds?.displayName ?? null,
    }));
  });

  app.get<{ Params: { id: string } }>("/api/templates/:id", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(400).send({ error: "invalid template id" });
    const row = await getTemplate(db, req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });

  /** Escalation log (briefing §8) — the data that drives lexicon/weight tuning. */
  app.get("/api/escalations", async (req, reply) => {
    const q = zEscalationQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid documentId or limit" });
    return listEscalations(db, {
      ...(q.data.documentId ? { documentId: q.data.documentId } : {}),
      limit: q.data.limit,
    });
  });

  app.get("/health", async (_req, reply) => {
    let dbOk = false;
    try {
      await db.execute(sql`select 1`);
      dbOk = true;
    } catch {
      dbOk = false;
    }
    let doclingOk = false;
    try {
      const res = await fetch(`${config.doclingUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      doclingOk = res.ok;
    } catch {
      doclingOk = false;
    }

    // A tick may legitimately sit inside a 300s VLM call, so the stall
    // threshold has to clear the longest legitimate stage before it can mean
    // anything. Beyond that, a loop that is running but has not completed a
    // tick is wedged — which is the poison-document failure mode.
    const stallAfterMs = config.pipeline.vlm.requestTimeoutMs + 60_000;
    const health = deps.worker?.();
    const workerOk =
      health === undefined
        ? null
        : health.running && Date.now() - (health.lastTickAt ?? 0) < stallAfterMs;

    // docling being down does NOT degrade: it is a dependency, it recovers on
    // its own, and the pipeline correctly retries. The database and the worker
    // do, because neither recovers without intervention.
    const ok = dbOk && workerOk !== false;
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      db: dbOk,
      docling: doclingOk,
      worker:
        health === undefined
          ? null
          : {
              ok: workerOk,
              running: health.running,
              lastTickAt: health.lastTickAt === null ? null : new Date(health.lastTickAt).toISOString(),
              busyForMs: health.inFlightSince === null ? null : Date.now() - health.inFlightSince,
            },
    });
  });

  return app;
}
