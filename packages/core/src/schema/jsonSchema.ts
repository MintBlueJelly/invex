import { z } from "zod";
import { zCanonicalInvoice } from "./invoice";

export type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema for VLM schema-constrained decoding, derived from the canonical Zod
 * schema (single source of truth). Constrained decoding is best-effort — some
 * backends reject keywords (patterns, formats); pass a sanitizer to strip them.
 * Post-hoc Zod validation remains the real guarantee.
 */
export function toVlmJsonSchema(opts?: {
  sanitize?: (schema: JsonSchema) => JsonSchema;
}): JsonSchema {
  const schema = z.toJSONSchema(zCanonicalInvoice) as JsonSchema;
  return opts?.sanitize ? opts.sanitize(schema) : schema;
}
