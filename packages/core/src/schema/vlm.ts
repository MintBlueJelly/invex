import { z } from "zod";
import { zCanonicalInvoice } from "./invoice";

/**
 * The single VLM response contract (briefing §6): handles both classification
 * (uncertain band) and extraction (escalations) in one schema-constrained call.
 * Non-invoices come back as Markdown; invoices as the canonical schema.
 */
export const zVlmResult = z.object({
  isInvoice: z.boolean(),
  invoice: zCanonicalInvoice.nullable(),
  markdown: z.string().nullable(),
});

export type VlmResult = z.infer<typeof zVlmResult>;

export function vlmResultJsonSchema(sanitize?: (s: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
  const schema = z.toJSONSchema(zVlmResult) as Record<string, unknown>;
  return sanitize ? sanitize(schema) : schema;
}
