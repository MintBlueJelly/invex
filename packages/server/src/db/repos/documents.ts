import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  documentEvents,
  documentFiles,
  documents,
  type DocumentStatus,
} from "../schema";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;
export type DocumentRow = typeof documents.$inferSelect;

export async function emitEvent(
  db: DbOrTx,
  documentId: string,
  event: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.insert(documentEvents).values({ documentId, event, detail: detail ?? {} });
}

export async function updateDocument(
  db: DbOrTx,
  id: string,
  patch: Partial<typeof documents.$inferInsert>,
): Promise<void> {
  await db
    .update(documents)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(documents.id, id));
}

export async function insertDocument(
  db: Db,
  input: { filename: string; contentHash: string; pdf: Uint8Array },
): Promise<DocumentRow> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(documents)
      .values({ filename: input.filename, contentHash: input.contentHash, status: "received" })
      .returning();
    const doc = rows[0]!;
    await tx.insert(documentFiles).values({ documentId: doc.id, pdf: input.pdf });
    await emitEvent(tx, doc.id, "ingested", {
      filename: input.filename,
      contentHash: input.contentHash,
      bytes: input.pdf.byteLength,
    });
    return doc;
  });
}

/** Idempotent re-ingest: an identical PDF that didn't fail is not processed twice. */
export async function findReusableByHash(db: Db, contentHash: string): Promise<DocumentRow | null> {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.contentHash, contentHash), sql`${documents.status} <> 'failed'`))
    .orderBy(desc(documents.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDocument(db: DbOrTx, id: string): Promise<DocumentRow | null> {
  const rows = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getPdf(db: DbOrTx, documentId: string): Promise<Uint8Array | null> {
  const rows = await db
    .select({ pdf: documentFiles.pdf })
    .from(documentFiles)
    .where(eq(documentFiles.documentId, documentId))
    .limit(1);
  return rows[0]?.pdf ?? null;
}

export async function listDocuments(
  db: Db,
  filter: { status?: DocumentStatus; limit: number },
): Promise<DocumentRow[]> {
  const base = db.select().from(documents);
  const query = filter.status ? base.where(eq(documents.status, filter.status)) : base;
  return query.orderBy(desc(documents.createdAt)).limit(filter.limit);
}

export interface TraceEvent {
  documentId: string;
  event: string;
  detail: Record<string, unknown> | null;
  at: Date;
}

/** Ordered event trace for a document and (if segmented) its children. */
export async function getTrace(db: Db, id: string): Promise<TraceEvent[]> {
  const children = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.parentId, id));
  const ids = [id, ...children.map((c) => c.id)];
  const rows = await db
    .select()
    .from(documentEvents)
    .where(inArray(documentEvents.documentId, ids))
    .orderBy(asc(documentEvents.id));
  return rows.map((r) => ({
    documentId: r.documentId,
    event: r.event,
    detail: r.detail,
    at: r.createdAt,
  }));
}

/**
 * Claim the next workable document with SELECT … FOR UPDATE SKIP LOCKED and run
 * `handler` inside the same transaction. Returns false when nothing was claimable.
 */
export async function claimNext(
  db: Db,
  claimable: ReturnType<typeof claimCondition>,
  handler: (tx: Tx, doc: DocumentRow) => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(documents)
      .where(claimable)
      .orderBy(asc(documents.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const doc = rows[0];
    if (!doc) return false;
    await handler(tx, doc);
    return true;
  });
}

/** WHERE clause for claimable work, built from the registered stage handlers. */
export function claimCondition(handledStatuses: DocumentStatus[], handledLanes: string[], maxAttempts: number) {
  const statusesExceptRouted = handledStatuses.filter((s) => s !== "routed");
  const parts = [];
  if (statusesExceptRouted.length > 0) {
    parts.push(inArray(documents.status, statusesExceptRouted));
  }
  if (handledStatuses.includes("routed") && handledLanes.length > 0) {
    parts.push(
      and(
        eq(documents.status, "routed"),
        inArray(sql`${documents.route}`, handledLanes),
      ),
    );
  }
  const anyOf = parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` OR `)})`;
  return and(anyOf, lt(documents.attempts, maxAttempts));
}

/** Record a stage error OUTSIDE the rolled-back stage transaction. */
export async function recordStageError(
  db: Db,
  id: string,
  err: unknown,
  maxAttempts: number,
): Promise<void> {
  const message = err instanceof Error ? `${err.message}` : String(err);
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(documents)
      .set({ attempts: sql`${documents.attempts} + 1`, error: message, updatedAt: sql`now()` })
      .where(eq(documents.id, id))
      .returning({ attempts: documents.attempts });
    const attempts = rows[0]?.attempts ?? maxAttempts;
    await emitEvent(tx, id, "stage_error", { message, attempt: attempts });
    if (attempts >= maxAttempts) {
      await tx
        .update(documents)
        .set({ status: "failed", updatedAt: sql`now()` })
        .where(eq(documents.id, id));
      await emitEvent(tx, id, "failed", { message, attempts });
    }
  });
}
