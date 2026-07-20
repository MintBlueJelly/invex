import Decimal from "decimal.js";
import type { ExtractionEnvelope, FieldMeta } from "../schema/candidate";
import type { CanonicalInvoice } from "../schema/invoice";
import { zCanonicalInvoice } from "../schema/invoice";
import { evaluateAll, type Tolerances } from "./constraints";
import { repairPass, unresolvedViolations, type RepairContext } from "./repairs";
import {
  defaultReconcileOptions,
  type ConstraintViolation,
  type ReconcileOptions,
  type ReconciliationResult,
} from "./types";
import { moneyStr, qtyStr, toWorking, type Working } from "./working";

/**
 * Constraint-based reconciler (briefing §4): parser and validator merge. Extraction
 * produces candidate fields, this solver repairs what is derivable from the
 * arithmetic over-determination, and only unresolvable inconsistencies escalate.
 * Shared verbatim by ALL paths — ZUGfERD XML included (§2 Path A).
 */
export function reconcile(
  envelope: ExtractionEnvelope,
  options?: Partial<ReconcileOptions>,
): ReconciliationResult {
  const opts: ReconcileOptions = { ...defaultReconcileOptions, ...options };
  const tol: Tolerances = {
    header: new Decimal(opts.toleranceHeader),
    line: new Decimal(opts.toleranceLine),
    lineSumSlackPerLine: new Decimal(opts.lineSumSlackPerLine),
  };

  const w = toWorking(envelope.invoice);
  const ctx: RepairContext = { repairs: [], vatRates: opts.vatRates, tol };

  // totalFailure is judged on the EXTRACTED values, pre-repair: a constraint that
  // only holds because a repair derived one of its operands from the others is
  // circular and corroborates nothing ("no amounts reconcile at all", §5).
  // Nothing evaluable at all is an EXTRACTION failure (→ VLM/review), not
  // misclassification evidence — totalFailure requires amounts that contradict.
  const preArithmetic = evaluateAll(toWorking(envelope.invoice), tol, opts.vatRates).filter(
    (c) => c.id !== "C5_VAT_CLOSED_SET",
  );
  const totalFailure =
    preArithmetic.some((c) => c.evaluable) && !preArithmetic.some((c) => c.evaluable && c.holds);

  // Bounded fix-point: rules only fill nulls, so each pass strictly reduces gaps.
  for (let pass = 0; pass < opts.maxRepairPasses; pass++) {
    if (!repairPass(w, ctx)) break;
  }

  const violations: ConstraintViolation[] = [];
  const checks = evaluateAll(w, tol, opts.vatRates);
  for (const check of checks) violations.push(...check.violations);
  violations.push(...unresolvedViolations(w));
  violations.push(...requiredFieldViolations(w));

  const outEnvelope = writeBack(envelope, w, ctx);

  if (violations.length > 0) {
    return { status: "failed", invoice: null, envelope: outEnvelope, repairs: ctx.repairs, violations, totalFailure };
  }

  const candidate = toCanonical(w, opts);
  const parsed = zCanonicalInvoice.safeParse(candidate);
  if (!parsed.success) {
    return {
      status: "failed",
      invoice: null,
      envelope: outEnvelope,
      repairs: ctx.repairs,
      violations: [
        {
          constraint: "SCHEMA_INVALID",
          paths: parsed.error.issues.map((i) => i.path.join(".")),
          detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      ],
      totalFailure,
    };
  }

  return {
    status: "reconciled",
    invoice: parsed.data,
    envelope: outEnvelope,
    repairs: ctx.repairs,
    violations: [],
    totalFailure: false,
  };
}

function requiredFieldViolations(w: Working): ConstraintViolation[] {
  const out: ConstraintViolation[] = [];
  const required: [string, unknown][] = [
    ["invoiceNumber", w.invoiceNumber],
    ["issueDate", w.issueDate],
    ["seller.name", w.seller.name],
  ];
  for (const [path, value] of required) {
    if (value === null) {
      out.push({ constraint: "REQUIRED_MISSING", paths: [path], detail: `required field ${path} was not extracted` });
    }
  }
  if (w.net === null || w.tax === null || w.gross === null) {
    out.push({
      constraint: "TOTALS_INCOMPLETE",
      paths: ["totals"],
      detail: "totals could not be completed from any combination of extracted amounts",
    });
  }
  if (w.vat.length === 0) {
    out.push({
      constraint: "VAT_MISSING",
      paths: ["vatBreakdown"],
      detail: "no VAT breakdown extracted and none could be synthesized from a closed-set rate",
    });
  } else if (w.vat.some((v) => v.rate === null || v.net === null || v.tax === null)) {
    out.push({
      constraint: "VAT_INCOMPLETE",
      paths: ["vatBreakdown"],
      detail: "VAT breakdown has entries with missing rate/net/tax that could not be completed",
    });
  }
  if (w.lines.length === 0) {
    out.push({
      constraint: "LINE_ITEMS_MISSING",
      paths: ["lineItems"],
      detail: "no line items extracted (description per line is mandatory)",
    });
  }
  return out;
}

/** Serialize the working model back to a canonical-shaped object. */
function toCanonical(w: Working, opts: ReconcileOptions): unknown {
  return {
    schemaVersion: 1,
    invoiceNumber: w.invoiceNumber,
    issueDate: w.issueDate,
    dueDate: w.dueDate,
    currency: w.currency ?? opts.defaultCurrency,
    locale: w.locale,
    seller: {
      name: w.seller.name,
      ustIdNr: w.seller.ustIdNr,
      steuernummer: w.seller.steuernummer,
      ibans: w.seller.ibans,
      address: w.seller.address,
    },
    buyer: w.buyer,
    totals: {
      net: w.net === null ? null : moneyStr(w.net),
      tax: w.tax === null ? null : moneyStr(w.tax),
      gross: w.gross === null ? null : moneyStr(w.gross),
    },
    vatBreakdown: w.vat.map((v) => ({
      rate: v.rate,
      net: v.net === null ? null : moneyStr(v.net),
      tax: v.tax === null ? null : moneyStr(v.tax),
    })),
    lineItems: w.lines.map((l) => ({
      position: l.position,
      description: l.description,
      quantity: l.quantity === null ? null : qtyStr(l.quantity),
      unit: l.unit,
      unitPrice: l.unitPrice === null ? null : qtyStr(l.unitPrice),
      taxRate: l.taxRate,
      lineTotal: l.lineTotal === null ? null : moneyStr(l.lineTotal),
    })),
    paymentTerms: w.paymentTerms,
  };
}

/**
 * Write repaired values back into a copy of the envelope and tag them as
 * source "derived" (confidence = 0.9 × the inputs' floor, defaulting to 0.8).
 */
function writeBack(envelope: ExtractionEnvelope, w: Working, ctx: RepairContext): ExtractionEnvelope {
  // Plain-JSON deep clone — core stays free of platform globals (no structuredClone).
  const invoice = JSON.parse(JSON.stringify(envelope.invoice)) as typeof envelope.invoice;
  const fieldMeta: Record<string, FieldMeta> = { ...envelope.fieldMeta };

  const existing = Object.values(envelope.fieldMeta).map((m) => m.confidence);
  const base = existing.length > 0 ? Math.min(...existing) : 0.9;
  const derivedConfidence = Math.max(0.1, Math.min(1, base * 0.9));

  for (const repair of ctx.repairs) {
    setPath(invoice as Record<string, unknown>, repair.path, valueAtPath(w, repair.path));
    fieldMeta[repair.path] = { source: "derived", confidence: derivedConfidence };
  }
  return { invoice, fieldMeta };
}

/** Resolve the post-repair value for a repaired path from the working model. */
function valueAtPath(w: Working, path: string): unknown {
  const parts = path.split(".");
  if (parts[0] === "totals") {
    const key = parts[1] as "net" | "tax" | "gross";
    const v = w[key];
    return v === null ? null : moneyStr(v);
  }
  if (parts[0] === "vatBreakdown") {
    const entry = w.vat[Number(parts[1])];
    if (!entry) return null;
    if (parts.length === 2) {
      return {
        rate: entry.rate,
        net: entry.net === null ? null : moneyStr(entry.net),
        tax: entry.tax === null ? null : moneyStr(entry.tax),
      };
    }
    const key = parts[2] as "rate" | "net" | "tax";
    if (key === "rate") return entry.rate;
    const v = entry[key];
    return v === null ? null : moneyStr(v);
  }
  if (parts[0] === "lineItems") {
    const line = w.lines[Number(parts[1])];
    if (!line) return null;
    const key = parts[2];
    switch (key) {
      case "quantity":
        return line.quantity === null ? null : qtyStr(line.quantity);
      case "unitPrice":
        return line.unitPrice === null ? null : qtyStr(line.unitPrice);
      case "lineTotal":
        return line.lineTotal === null ? null : moneyStr(line.lineTotal);
      case "taxRate":
        return line.taxRate;
      default:
        return null;
    }
  }
  return null;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const nextIsIndex = /^\d+$/.test(parts[i + 1]!);
    if (cur[key] === null || cur[key] === undefined) {
      cur[key] = nextIsIndex ? [] : {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}
