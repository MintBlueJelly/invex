import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  vlmResultJsonSchema,
  zVlmResult,
  type CandidateInvoice,
  type CanonicalInvoice,
  type DocumentType,
  type ExtractionEnvelope,
  type FieldMeta,
} from "@invex/core";
import type { StageHandler } from "../machine";
import { emitEvent, getPdf, updateDocument } from "../../db/repos/documents";
import { rasterizePdf } from "../../pdf/rasterize";

/**
 * escalated_vlm → extracted | exported_markdown. Rasterizes the original PDF
 * (the document's own pages for segmentation children) and asks the VLM for a
 * schema-constrained result; the shared solver then judges it like any other
 * candidate (briefing §2/§6). Zod validation is the hard gate — constrained
 * decoding is best-effort.
 */
export const vlmEscalateStage: StageHandler = async (tx, doc, ports) => {
  const cfg = ports.config.pipeline;
  const pdf =
    (await getPdf(tx, doc.id)) ?? (doc.parentId ? await getPdf(tx, doc.parentId) : null);
  if (!pdf) throw new Error(`document ${doc.id} has no PDF for VLM rasterization`);

  const images = await rasterizePdf(pdf, {
    dpi: cfg.vlm.rasterDpi,
    maxPages: cfg.vlm.maxPages,
    ...(doc.segmentPages ? { pages: doc.segmentPages } : {}),
  });
  const systemPrompt = await readFile(
    join(ports.config.promptsDir, "invoice-extract.md"),
    "utf8",
  );

  const res = await ports.vlm.extractStructured({
    images,
    jsonSchema: vlmResultJsonSchema(),
    systemPrompt,
  });
  await emitEvent(tx, doc.id, "vlm_called", { model: res.model, pages: images.length });

  const parsed = zVlmResult.safeParse(res.json);
  if (!parsed.success) {
    // Throw → stage_error → bounded retries → failed. The client already
    // retried once with feedback; a model that can't hit the schema is a
    // configuration problem worth surfacing loudly.
    throw new Error(`VLM result failed schema validation: ${parsed.error.message.slice(0, 500)}`);
  }

  // null documentType = none of the five classes we extract -> Markdown.
  if (parsed.data.documentType === null) {
    await updateDocument(tx, doc.id, {
      status: "exported_markdown",
      vlmAttempted: true,
      markdown: parsed.data.markdown ?? doc.markdown ?? "",
    });
    await emitEvent(tx, doc.id, "markdown_exported", { reason: "vlm_non_invoice" });
    return;
  }
  if (!parsed.data.document) {
    throw new Error(
      `VLM classified the document as ${parsed.data.documentType} but returned no payload`,
    );
  }

  await updateDocument(tx, doc.id, {
    status: "extracted",
    vlmAttempted: true,
    candidate: envelopeFromVlm(parsed.data.document, parsed.data.documentType),
  });
};

/** Wrap a VLM-produced canonical document as a candidate envelope (source: vlm). */
function envelopeFromVlm(document: CanonicalInvoice, documentType: DocumentType): ExtractionEnvelope {
  const { schemaVersion: _v, ...candidate } = document;
  const fieldMeta: Record<string, FieldMeta> = {};
  const mark = (path: string) => {
    fieldMeta[path] = { source: "vlm", confidence: 0.75 };
  };
  // The top-level documentType is authoritative over the one inside the
  // payload: it is the field the model was asked to classify with.
  candidate.documentType = documentType;
  mark("documentType");
  mark("documentNumber");
  mark("documentDate");
  mark("totals.net");
  mark("totals.tax");
  mark("totals.gross");
  mark("seller.name");
  document.lineItems.forEach((_, i) => mark(`lineItems.${i}`));
  document.vatBreakdown.forEach((_, i) => mark(`vatBreakdown.${i}`));
  return { invoice: candidate as CandidateInvoice, fieldMeta };
}
