import { desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./documents";
import { escalations, type EscalationStage } from "../schema";

/**
 * Escalation log (briefing §8): on every escalation record WHICH constraint or
 * rule failed plus the classifier feature vector — this data prioritizes
 * lexicon/rule additions and weight tuning.
 */
export async function recordEscalation(
  db: DbOrTx,
  input: {
    documentId: string;
    stage: EscalationStage;
    failedConstraints?: unknown[];
    failedRules?: string[];
    classifierFeatures?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(escalations).values({
    documentId: input.documentId,
    stage: input.stage,
    failedConstraints: input.failedConstraints ?? null,
    failedRules: input.failedRules ?? null,
    classifierFeatures: input.classifierFeatures ?? null,
  });
}

export async function resolveEscalations(
  db: DbOrTx,
  documentId: string,
  resolution: string,
): Promise<void> {
  await db
    .update(escalations)
    .set({ resolvedAt: sql`now()`, resolution })
    .where(eq(escalations.documentId, documentId));
}

export async function listEscalations(
  db: DbOrTx,
  filter: { documentId?: string; limit: number },
) {
  const base = db.select().from(escalations);
  const query = filter.documentId
    ? base.where(eq(escalations.documentId, filter.documentId))
    : base;
  return query.orderBy(desc(escalations.createdAt)).limit(filter.limit);
}
