import { z } from "zod";

/** Non-invoice output shape (briefing §1: Markdown for downstream LLM processing). */
export const zMarkdownExport = z.object({
  documentId: z.uuid(),
  classification: z.enum([
    "non_invoice",
    "reclassified_total_failure",
    "vlm_non_invoice",
  ]),
  source: z.enum(["docling", "vlm"]),
  markdown: z.string(),
  pageCount: z.number().int().nonnegative(),
  classifierScore: z.number().nullable(),
});

export type MarkdownExport = z.infer<typeof zMarkdownExport>;
