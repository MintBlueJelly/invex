import {
  applyTemplateOcr,
  classify,
  extractVendorIds,
  mapDoclingDocument,
  mergeLines,
  mergeEnvelopes,
  positionedToMarkdown,
  type ExtractionEnvelope,
} from "@invex/core";
import type { StageHandler } from "../machine";
import { emitEvent, getPdf, updateDocument } from "../../db/repos/documents";
import { recordEscalation } from "../../db/repos/escalations";
import { resolveVendor } from "../../db/repos/templates";

/**
 * Path C (briefing §2, MVP cuts applied): cheap CPU OCR ONLY to extract vendor
 * identifiers; a known vendor's template runs directly on the OCR output (the
 * GPU stays cold); unknown vendors go to the VLM, whose result becomes a new
 * template. No generic OCR table reconstruction.
 */
export const imageLaneStage: StageHandler = async (tx, doc, ports) => {
  const cfg = ports.config.pipeline;
  const pdf = await getPdf(tx, doc.id);
  if (!pdf) throw new Error(`document ${doc.id} has no stored PDF bytes`);

  const converted = await ports.docling.convert(pdf, { ocr: true, tables: false });
  const positioned = mergeLines(mapDoclingDocument(converted.doclingJson, converted.markdown));
  const markdown = positioned.markdown ?? positionedToMarkdown(positioned);

  // Feature vector logged on every document (§5) — even where the VLM decides.
  const classification = classify(positioned, ports.config.classifier);
  await emitEvent(tx, doc.id, "classified", {
    band: classification.band,
    score: classification.score,
    features: classification.features,
  });

  const ids = extractVendorIds(positioned);
  const resolved = await resolveVendor(tx, {
    ustIdNr: ids.ustIdNr,
    steuernummer: ids.steuernummer,
    ibans: ids.ibans,
    nameHash: ids.nameHash,
  });
  await emitEvent(tx, doc.id, "vendor_resolved", {
    ...(resolved
      ? { matchedBy: resolved.matchedBy, templateId: resolved.row.id, version: resolved.row.version }
      : {}),
    extracted: { ustIdNr: ids.ustIdNr, steuernummer: ids.steuernummer, ibans: ids.ibans },
  });

  if (resolved) {
    const applied = applyTemplateOcr(resolved.template, positioned);
    await emitEvent(tx, doc.id, "template_applied", {
      templateId: resolved.row.id,
      onOcr: true,
      fieldsHit: applied.fieldsHit,
      fieldsMissed: applied.fieldsMissed,
    });
    const idEnvelope: ExtractionEnvelope = {
      invoice: { seller: { name: ids.nameGuess, ustIdNr: ids.ustIdNr, steuernummer: ids.steuernummer, ibans: ids.ibans } },
      fieldMeta: {},
    };
    await updateDocument(tx, doc.id, {
      status: "extracted",
      candidate: mergeEnvelopes(applied.envelope, idEnvelope),
      classifier: classification as unknown as Record<string, unknown>,
      markdown,
      positionedDoc: positioned as unknown as Record<string, unknown>,
    });
    return;
  }

  // Unknown vendor: the VLM parses AND classifies; its result persists a template.
  if (cfg.vlm.enabled && !doc.vlmAttempted) {
    await updateDocument(tx, doc.id, {
      status: "escalated_vlm",
      classifier: classification as unknown as Record<string, unknown>,
      markdown,
      positionedDoc: positioned as unknown as Record<string, unknown>,
    });
    await emitEvent(tx, doc.id, "escalated", { to: "vlm", reason: "image_no_template" });
    await recordEscalation(tx, {
      documentId: doc.id,
      stage: "rules_to_vlm",
      classifierFeatures: classification as unknown as Record<string, unknown>,
    });
    return;
  }

  // Last resort without a VLM: human review sees the OCR-derived identifiers.
  await updateDocument(tx, doc.id, {
    status: "pending_review",
    candidate: {
      invoice: { seller: { name: ids.nameGuess, ustIdNr: ids.ustIdNr, steuernummer: ids.steuernummer, ibans: ids.ibans } },
      fieldMeta: {},
    },
    classifier: classification as unknown as Record<string, unknown>,
    markdown,
    positionedDoc: positioned as unknown as Record<string, unknown>,
  });
  await emitEvent(tx, doc.id, "escalated", { to: "human_review", reason: "image_no_template_no_vlm" });
  await recordEscalation(tx, {
    documentId: doc.id,
    stage: "vlm_to_review",
    classifierFeatures: classification as unknown as Record<string, unknown>,
  });
};
