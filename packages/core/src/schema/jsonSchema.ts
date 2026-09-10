import { z } from "zod";
import { zCanonicalInvoiceShape } from "./invoice";

export type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema for VLM schema-constrained decoding, derived from the canonical Zod
 * schema (single source of truth). Constrained decoding is best-effort — some
 * backends reject keywords (patterns, formats); pass a sanitizer to strip them.
 * Post-hoc Zod validation remains the real guarantee.
 *
 * Derived from the unrefined SHAPE: the per-document-class amount requirements
 * on zCanonicalInvoice are a custom check, which JSON Schema cannot express and
 * zod silently omits. Generating from the shape makes that omission explicit
 * rather than incidental.
 */
export function toVlmJsonSchema(opts?: {
  sanitize?: (schema: JsonSchema) => JsonSchema;
}): JsonSchema {
  const schema = z.toJSONSchema(zCanonicalInvoiceShape) as JsonSchema;
  return opts?.sanitize ? opts.sanitize(schema) : schema;
}
