import type { FastifyInstance } from "fastify";
import {
  zCanonicalInvoice,
  type PositionedTextDocument,
} from "@invex/core";
import type { Db } from "../db/client";
import {
  emitEvent,
  getDocument,
  listDocuments,
  updateDocument,
} from "../db/repos/documents";
import { resolveEscalations } from "../db/repos/escalations";
import { induceAndPersistTemplate } from "../pipeline/templateFeedback";

/**
 * Human review (briefing §7): input is the original PDF (via /documents/:id/pdf)
 * side-by-side with the candidate JSON; the commit writes BOTH the invoice
 * output AND a vendor template create/update — the required feedback edge the
 * original diagram was missing. UI priority later: line-item corrections
 * convert one-off extractions into durable templates.
 */
export function registerReviewRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/review", async () => {
    const rows = await listDocuments(db, { status: "pending_review", limit: 100 });
    return rows.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      route: doc.route,
      vendorGuess: (doc.candidate?.invoice.seller?.name as string | null) ?? null,
      violationSummary: (doc.violations ?? []).map((v) => v.constraint),
      createdAt: doc.createdAt,
    }));
  });

  app.get<{ Params: { id: string } }>("/api/review/:id", async (req, reply) => {
    const doc = await getDocument(db, req.params.id);
    if (!doc) return reply.code(404).send({ error: "not found" });
    if (doc.status !== "pending_review") {
      return reply.code(409).send({ error: `document is ${doc.status}, not pending_review` });
    }
    return {
      id: doc.id,
      filename: doc.filename,
      route: doc.route,
      candidate: doc.candidate,
      violations: doc.violations,
      repairs: doc.repairs,
      classifier: doc.classifier,
      pdfUrl: `/api/documents/${doc.id}/pdf`,
    };
  });

  app.put<{ Params: { id: string } }>("/api/review/:id", async (req, reply) => {
    const doc = await getDocument(db, req.params.id);
    if (!doc) return reply.code(404).send({ error: "not found" });
    if (doc.status !== "pending_review") {
      return reply.code(409).send({ error: `document is ${doc.status}, not pending_review` });
    }
    const parsed = zCanonicalInvoice.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid canonical invoice",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const invoice = parsed.data;

    let templateId: string | null = null;
    await db.transaction(async (tx) => {
      await updateDocument(tx, doc.id, {
        status: "committed",
        result: invoice,
        violations: [],
      });
      await emitEvent(tx, doc.id, "review_committed", {
        gross: invoice.totals.gross,
        lineCount: invoice.lineItems.length,
      });
      // §7: corrections flow to output AND template create/update.
      if (doc.positionedDoc) {
        const persisted = await induceAndPersistTemplate(
          tx,
          doc.id,
          invoice,
          doc.positionedDoc as unknown as PositionedTextDocument,
          "human_review",
        );
        templateId = persisted?.id ?? null;
      }
      await resolveEscalations(tx, doc.id, "human_review");
    });

    return reply.code(200).send({ documentId: doc.id, status: "committed", templateId });
  });
}
