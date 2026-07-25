import { z } from "zod";

/**
 * Request parameter validation.
 *
 * Path ids go straight into `eq(documents.id, …)` against a uuid column, so an
 * unvalidated one raises Postgres 22P02 — which Fastify renders as a 500 whose
 * body contains the failed SQL statement and its bound parameters. Wrong status
 * code and internals disclosure on the same request (INVEX-008).
 *
 * `?limit=` had the same shape of problem: `Number("abc")` is NaN, which
 * survived `Math.min(Math.max(NaN, 1), 500)` unchanged and reached `.limit(NaN)`.
 *
 * Lives in its own module so both app.ts and review.ts can use it without a
 * circular import.
 */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const zLimitQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const zEscalationQuery = z.object({
  documentId: z.string().regex(UUID_RE).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
