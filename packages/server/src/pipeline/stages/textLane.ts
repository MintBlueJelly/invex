import {
  applyTemplate,
  classify,
  extractVendorIds,
  mapDoclingDocument,
  mergeEnvelopes,
  positionedToMarkdown,
  runRuleEngine,
  runTextGate,
  segmentPages,
  slicePages,
  type ExtractionEnvelope,
  type PositionedTextDocument,
} from "@invex/core";
import type { StageHandler } from "../machine";
import type { Tx, DocumentRow } from "../../db/repos/documents";
import { emitEvent, getPdf, updateDocument } from "../../db/repos/documents";
import { recordEscalation } from "../../db/repos/escalations";
import { resolveVendor } from "../../db/repos/templates";
import { documents } from "../../db/schema";

/**
 * Path B (briefing §2): text-quality gate → page segmentation → classification
 * (3 bands) → template-first deterministic extraction (rule engine fills gaps)
 * → hands off to the shared reconcile stage. Non-invoices exit as Markdown.
 */
export const textLaneStage: StageHandler = async (tx, doc, ports) => {
  const cfg = ports.config.pipeline;

  // Segmentation children arrive with their positioned doc pre-sliced.
  let positioned = doc.positionedDoc as unknown as PositionedTextDocument | null;

  if (!positioned) {
    const pdf = await getPdf(tx, doc.id);
    if (!pdf) throw new Error(`document ${doc.id} has no stored PDF bytes`);
    const converted = await ports.docling.convert(pdf, { ocr: false, tables: true });
    positioned = mapDoclingDocument(converted.doclingJson, converted.markdown);

    // 1. Text-quality gate: garbage text layers reroute to Path C.
    const gate = runTextGate(positioned, cfg.textGate);
    await emitEvent(tx, doc.id, "text_gate", {
      verdict: gate.verdict,
      dictHitRate: gate.dictHitRate,
      cidTokens: gate.cidTokens,
      reasons: gate.reasons,
    });
    if (gate.verdict === "garbage") {
      await updateDocument(tx, doc.id, { status: "routed", route: "image" });
      await recordEscalation(tx, { documentId: doc.id, stage: "text_gate_reroute" });
      return;
    }

    // 2. Page-level segmentation.
    const segments = segmentPages(positioned);
    const invoiceSegments = segments.filter((s) => s.kind === "invoice-candidate");
    if (segments.length > 1) {
      await emitEvent(tx, doc.id, "segmented", {
        segments: segments.length,
        kinds: segments.map((s) => `${s.kind}:${s.pages.join(",")}`),
      });
    }
    if (invoiceSegments.length > 1) {
      // Multi-invoice PDF: spawn one child document per invoice segment.
      for (const seg of invoiceSegments) {
        const slice = slicePages(positioned, seg.pages);
        const rows = await tx
          .insert(documents)
          .values({
            parentId: doc.id,
            filename: `${doc.filename}#p${seg.pages.join("-")}`,
            contentHash: `${doc.contentHash}:${seg.pages.join("-")}`,
            status: "routed",
            route: "text",
            segmentPages: seg.pages,
            positionedDoc: slice as unknown as Record<string, unknown>,
          })
          .returning({ id: documents.id });
        await emitEvent(tx, rows[0]!.id, "ingested", {
          parent: doc.id,
          pages: seg.pages,
        });
      }
      await updateDocument(tx, doc.id, { status: "segmented" });
      return;
    }
    if (segments.length > 1 && invoiceSegments.length === 1) {
      // Attachment pages (terms etc.) are excluded from extraction.
      positioned = slicePages(positioned, invoiceSegments[0]!.pages);
    }
  }

  // 3. Classification: weighted feature score, three bands (§5).
  const classification = classify(positioned, ports.config.classifier);
  await emitEvent(tx, doc.id, "classified", {
    band: classification.band,
    score: classification.score,
    features: classification.features,
  });

  const markdown = positioned.markdown ?? positionedToMarkdown(positioned);

  if (classification.band === "non_invoice") {
    await updateDocument(tx, doc.id, {
      status: "exported_markdown",
      classifier: classification as unknown as Record<string, unknown>,
      markdown,
      positionedDoc: positioned as unknown as Record<string, unknown>,
    });
    await emitEvent(tx, doc.id, "markdown_exported", { reason: "non_invoice" });
    return;
  }
  // "uncertain" goes to the VLM for classification (§5). Without a VLM the
  // solver decides: constraint closure is strong invoice evidence, total
  // failure reroutes to Markdown.
  if (classification.band === "uncertain" && cfg.vlm.enabled) {
    await updateDocument(tx, doc.id, {
      status: "escalated_vlm",
      classifier: classification as unknown as Record<string, unknown>,
      markdown,
      positionedDoc: positioned as unknown as Record<string, unknown>,
    });
    await emitEvent(tx, doc.id, "escalated", { to: "vlm", reason: "uncertain_classification" });
    await recordEscalation(tx, {
      documentId: doc.id,
      stage: "rules_to_vlm",
      classifierFeatures: classification as unknown as Record<string, unknown>,
    });
    return;
  }

  // 4. Deterministic extraction: template lookup first, rule engine fills gaps.
  const envelope = await extractDeterministic(tx, doc, positioned);

  await updateDocument(tx, doc.id, {
    status: "extracted",
    candidate: envelope,
    classifier: classification as unknown as Record<string, unknown>,
    markdown,
    positionedDoc: positioned as unknown as Record<string, unknown>,
  });
};

async function extractDeterministic(
  tx: Tx,
  doc: DocumentRow,
  positioned: PositionedTextDocument,
): Promise<ExtractionEnvelope> {
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
    extracted: {
      ustIdNr: ids.ustIdNr,
      steuernummer: ids.steuernummer,
      ibans: ids.ibans,
      nameGuess: ids.nameGuess,
    },
  });

  const rules = runRuleEngine(positioned);
  await emitEvent(tx, doc.id, "rules_applied", {
    found: rules.fieldsFound,
    missed: rules.fieldsMissed,
  });

  let envelope = rules.envelope;
  if (resolved) {
    const applied = applyTemplate(resolved.template, positioned);
    await emitEvent(tx, doc.id, "template_applied", {
      templateId: resolved.row.id,
      fieldsHit: applied.fieldsHit,
      fieldsMissed: applied.fieldsMissed,
    });
    envelope = mergeEnvelopes(applied.envelope, rules.envelope);
  }

  // Extracted vendor identity fills whatever template/rules left open.
  const idEnvelope: ExtractionEnvelope = {
    invoice: {
      seller: {
        name: ids.nameGuess,
        ustIdNr: ids.ustIdNr,
        steuernummer: ids.steuernummer,
        ibans: ids.ibans,
      },
    },
    fieldMeta: {
      ...(ids.ustIdNr ? { "seller.ustIdNr": { source: "rules" as const, confidence: 0.9 } } : {}),
      ...(ids.nameGuess ? { "seller.name": { source: "rules" as const, confidence: 0.5 } } : {}),
    },
  };
  return mergeEnvelopes(envelope, idEnvelope);
}
