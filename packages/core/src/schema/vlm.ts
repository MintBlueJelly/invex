import { z } from "zod";
import { zCanonicalInvoiceShape } from "./invoice";
import { zDocumentType } from "./documentType";

/**
 * The single VLM response contract (briefing §6): handles both classification
 * (uncertain band) and extraction (escalations) in one schema-constrained call.
 * Documents we extract come back as the canonical schema; everything else as
 * Markdown.
 *
 * documentType replaced the v1 isInvoice boolean rather than joining it: two
 * fields that can contradict each other ("isInvoice: false" beside a populated
 * invoice) is a bug generator, and one nullable enum makes that state
 * unrepresentable while shrinking the decoding grammar. null means "none of the
 * five classes" -> Markdown.
 *
 * Built on the unrefined SHAPE, not zCanonicalInvoice: this schema is fed to
 * z.toJSONSchema for constrained decoding, and a custom check cannot be
 * expressed in JSON Schema (zod silently drops it). The per-class requirements
 * are enforced by the solver, which every VLM result passes through anyway.
 */
export const zVlmResult = z.object({
  documentType: zDocumentType.nullable(),
  document: zCanonicalInvoiceShape.nullable(),
  markdown: z.string().nullable(),
});

export type VlmResult = z.infer<typeof zVlmResult>;

export function vlmResultJsonSchema(sanitize?: (s: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
  const schema = z.toJSONSchema(zVlmResult) as Record<string, unknown>;
  return sanitize ? sanitize(schema) : schema;
}
