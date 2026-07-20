import type { CanonicalInvoice } from "../schema/invoice";
import type { ExtractionEnvelope } from "../schema/candidate";

/**
 * Solver configuration. Tolerances are string decimals (never float) and come
 * from config/pipeline.json in the server; core only defines the shape/defaults.
 */
export interface ReconcileOptions {
  /** Closed set of admissible VAT rates in percent (briefing §4: 19, 7, 0). */
  vatRates: number[];
  /** Tolerance for header-level constraints (net+tax=gross, VAT sums). */
  toleranceHeader: string;
  /** Tolerance for per-line arithmetic (qty × unitPrice = lineTotal). */
  toleranceLine: string;
  /** Extra slack per line for Σ(lines)=net — absorbs per-line rounding. */
  lineSumSlackPerLine: string;
  maxRepairPasses: number;
  defaultCurrency: string;
}

export const defaultReconcileOptions: ReconcileOptions = {
  vatRates: [19, 7, 0],
  toleranceHeader: "0.02",
  toleranceLine: "0.01",
  lineSumSlackPerLine: "0.005",
  maxRepairPasses: 5,
  defaultCurrency: "EUR",
};

export interface AppliedRepair {
  rule: string;
  /** Field path in the canonical JSON, e.g. "lineItems.2.unitPrice". */
  path: string;
  to: string;
}

export interface ConstraintViolation {
  constraint: string;
  paths: string[];
  detail: string;
  /** Signed difference as decimal string, where meaningful. */
  delta?: string;
  /** Machine-readable hypothesis, e.g. "lines_may_be_gross". */
  hint?: string;
}

export interface ReconciliationResult {
  status: "reconciled" | "failed";
  /** Zod-valid canonical invoice — only non-null when status is "reconciled". */
  invoice: CanonicalInvoice | null;
  /** Input envelope with repaired values written back and "derived" fieldMeta added. */
  envelope: ExtractionEnvelope;
  repairs: AppliedRepair[];
  violations: ConstraintViolation[];
  /**
   * True when arithmetic constraints (C1–C4) WERE evaluable on the EXTRACTED
   * (pre-repair) values and NOT A SINGLE one held — the briefing §5
   * reclassification signal ("no amounts reconcile at all"). Post-repair checks
   * don't count (a constraint satisfied by a value it itself derived is
   * circular), and "nothing extracted" doesn't count either — that's an
   * extraction failure to escalate, not evidence the document is no invoice.
   */
  totalFailure: boolean;
}
