import { reconcile, type PositionedTextDocument } from "@invex/core";
import type { StageHandler } from "../machine";
import { emitEvent, updateDocument } from "../../db/repos/documents";
import { recordEscalation } from "../../db/repos/escalations";
import { induceAndPersistTemplate } from "../templateFeedback";

/**
 * extracted → committed | escalated_vlm | pending_review | exported_markdown.
 * Runs the shared constraint solver (briefing §4) on the candidate envelope,
 * whatever lane produced it — Path A included.
 */
export const reconcileStage: StageHandler = async (tx, doc, ports) => {
  if (!doc.candidate) throw new Error(`document ${doc.id} reached reconcile without a candidate`);
  const cfg = ports.config.pipeline;

  const result = reconcile(doc.candidate, {
    ...cfg.reconcile,
    defaultCurrency: cfg.defaults.currency,
  });

  await emitEvent(tx, doc.id, "reconciled", {
    status: result.status,
    repairs: result.repairs,
    violations: result.violations,
    totalFailure: result.totalFailure,
  });

  if (result.status === "reconciled") {
    await updateDocument(tx, doc.id, {
      status: "committed",
      result: result.invoice!,
      candidate: result.envelope,
      repairs: result.repairs,
      violations: [],
    });
    await emitEvent(tx, doc.id, "committed", {
      gross: result.invoice!.totals.gross,
      lineCount: result.invoice!.lineItems.length,
      repairCount: result.repairs.length,
    });

    // Template feedback edges (briefing §3/§6): every successful VLM extraction
    // persists a template; a successful template-less rule-engine run optionally
    // does too — both grow deterministic coverage.
    const sources = new Set(Object.values(doc.candidate.fieldMeta).map((m) => m.source));
    if (doc.positionedDoc && (doc.route === "text" || doc.route === "image")) {
      const positioned = doc.positionedDoc as unknown as PositionedTextDocument;
      if (sources.has("vlm")) {
        await induceAndPersistTemplate(tx, doc.id, result.invoice!, positioned, "vlm");
      } else if (cfg.templates.induceFromRuleEngine && !sources.has("template")) {
        await induceAndPersistTemplate(tx, doc.id, result.invoice!, positioned, "rule_engine");
      }
    }
    return;
  }

  // Failure routing (briefing §2/§5):
  const classifier = doc.classifier as { band?: string; score?: number } | null;

  // "Classified as invoice but NO amounts reconcile at all" → probable
  // misclassification → Markdown path, never human review (§5).
  if (result.totalFailure && classifier?.band === "invoice" && doc.markdown !== null) {
    await updateDocument(tx, doc.id, {
      status: "exported_markdown",
      candidate: result.envelope,
      repairs: result.repairs,
      violations: result.violations,
    });
    await emitEvent(tx, doc.id, "markdown_exported", { reason: "reclassified_total_failure" });
    await recordEscalation(tx, {
      documentId: doc.id,
      stage: "reclassified_markdown",
      failedConstraints: result.violations,
      ...(classifier ? { classifierFeatures: classifier } : {}),
    });
    return;
  }

  const canEscalateToVlm = cfg.vlm.enabled && !doc.vlmAttempted;
  if (canEscalateToVlm) {
    await updateDocument(tx, doc.id, {
      status: "escalated_vlm",
      candidate: result.envelope,
      repairs: result.repairs,
      violations: result.violations,
    });
    await emitEvent(tx, doc.id, "escalated", { to: "vlm", violations: result.violations.length });
    await recordEscalation(tx, {
      documentId: doc.id,
      stage: "rules_to_vlm",
      failedConstraints: result.violations,
      ...(classifier ? { classifierFeatures: classifier } : {}),
    });
    return;
  }

  await updateDocument(tx, doc.id, {
    status: "pending_review",
    candidate: result.envelope,
    repairs: result.repairs,
    violations: result.violations,
  });
  await emitEvent(tx, doc.id, "escalated", {
    to: "human_review",
    vlmAttempted: doc.vlmAttempted,
    violations: result.violations.length,
  });
  await recordEscalation(tx, {
    documentId: doc.id,
    stage: "vlm_to_review",
    failedConstraints: result.violations,
    ...(classifier ? { classifierFeatures: classifier } : {}),
  });
};
