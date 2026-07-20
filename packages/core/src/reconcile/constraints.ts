import Decimal from "decimal.js";
import type { Working } from "./working";
import type { ConstraintViolation } from "./types";

/**
 * Arithmetic constraints (briefing §4). Invoices are over-determined; each check
 * reports whether it was evaluable at all — "not evaluable" is neither pass nor
 * fail and never counts toward totalFailure.
 */

export interface ConstraintCheck {
  id: string;
  evaluable: boolean;
  holds: boolean;
  violations: ConstraintViolation[];
}

interface Tolerances {
  header: Decimal;
  line: Decimal;
  lineSumSlackPerLine: Decimal;
}

function within(delta: Decimal, tol: Decimal): boolean {
  return delta.abs().lte(tol);
}

/** C1: net + tax = gross */
export function c1Totals(w: Working, tol: Tolerances): ConstraintCheck {
  if (w.net === null || w.tax === null || w.gross === null) {
    return { id: "C1_TOTALS", evaluable: false, holds: false, violations: [] };
  }
  const delta = w.net.plus(w.tax).minus(w.gross);
  const holds = within(delta, tol.header);
  return {
    id: "C1_TOTALS",
    evaluable: true,
    holds,
    violations: holds
      ? []
      : [
          {
            constraint: "C1_TOTALS",
            paths: ["totals.net", "totals.tax", "totals.gross"],
            detail: `net (${w.net}) + tax (${w.tax}) != gross (${w.gross})`,
            delta: delta.toFixed(2),
          },
        ],
  };
}

/** C2: Σ(line totals) = totals.net — with gross-lines hypothesis hint on failure. */
export function c2LineSum(w: Working, tol: Tolerances): ConstraintCheck {
  if (w.net === null || w.lines.length === 0 || w.lines.some((l) => l.lineTotal === null)) {
    return { id: "C2_LINE_SUM", evaluable: false, holds: false, violations: [] };
  }
  const sum = w.lines.reduce((acc, l) => acc.plus(l.lineTotal as Decimal), new Decimal(0));
  const tolerance = tol.header.plus(tol.lineSumSlackPerLine.times(w.lines.length));
  const delta = sum.minus(w.net);
  const holds = within(delta, tolerance);
  if (holds) return { id: "C2_LINE_SUM", evaluable: true, holds: true, violations: [] };

  const grossMatch = w.gross !== null && within(sum.minus(w.gross), tolerance);
  return {
    id: "C2_LINE_SUM",
    evaluable: true,
    holds: false,
    violations: [
      {
        constraint: "C2_LINE_SUM",
        paths: ["lineItems", "totals.net"],
        detail: `sum of line totals (${sum.toFixed(2)}) != totals.net (${w.net})`,
        delta: delta.toFixed(2),
        ...(grossMatch ? { hint: "lines_may_be_gross" } : {}),
      },
    ],
  };
}

/** C3: quantity × unitPrice = lineTotal, per line. */
export function c3LineMath(w: Working, tol: Tolerances): ConstraintCheck {
  let evaluable = false;
  const violations: ConstraintViolation[] = [];
  w.lines.forEach((l, i) => {
    if (l.quantity === null || l.unitPrice === null || l.lineTotal === null) return;
    evaluable = true;
    const delta = l.quantity.times(l.unitPrice).minus(l.lineTotal);
    if (!within(delta, tol.line)) {
      violations.push({
        constraint: "C3_LINE_MATH",
        paths: [`lineItems.${i}.quantity`, `lineItems.${i}.unitPrice`, `lineItems.${i}.lineTotal`],
        detail: `line ${i}: ${l.quantity} × ${l.unitPrice} != ${l.lineTotal}`,
        delta: delta.toFixed(2),
      });
    }
  });
  return { id: "C3_LINE_MATH", evaluable, holds: evaluable && violations.length === 0, violations };
}

/** C4: VAT breakdown internally consistent and matching the header totals. */
export function c4VatSum(w: Working, tol: Tolerances): ConstraintCheck {
  const complete = w.vat.filter((v) => v.rate !== null && v.net !== null && v.tax !== null);
  if (complete.length === 0 || complete.length !== w.vat.length) {
    return { id: "C4_VAT_SUM", evaluable: false, holds: false, violations: [] };
  }
  const violations: ConstraintViolation[] = [];
  complete.forEach((v, i) => {
    const expected = (v.net as Decimal).times(v.rate as number).div(100);
    const delta = expected.minus(v.tax as Decimal);
    if (!within(delta, tol.header)) {
      violations.push({
        constraint: "C4_VAT_SUM",
        paths: [`vatBreakdown.${i}`],
        detail: `VAT entry ${i}: ${v.net} × ${v.rate}% != ${v.tax}`,
        delta: delta.toFixed(2),
      });
    }
  });
  if (w.net !== null) {
    const sumNet = complete.reduce((a, v) => a.plus(v.net as Decimal), new Decimal(0));
    const delta = sumNet.minus(w.net);
    if (!within(delta, tol.header)) {
      violations.push({
        constraint: "C4_VAT_SUM",
        paths: ["vatBreakdown", "totals.net"],
        detail: `sum of VAT nets (${sumNet.toFixed(2)}) != totals.net (${w.net})`,
        delta: delta.toFixed(2),
      });
    }
  }
  if (w.tax !== null) {
    const sumTax = complete.reduce((a, v) => a.plus(v.tax as Decimal), new Decimal(0));
    const delta = sumTax.minus(w.tax);
    if (!within(delta, tol.header)) {
      violations.push({
        constraint: "C4_VAT_SUM",
        paths: ["vatBreakdown", "totals.tax"],
        detail: `sum of VAT taxes (${sumTax.toFixed(2)}) != totals.tax (${w.tax})`,
        delta: delta.toFixed(2),
      });
    }
  }
  return { id: "C4_VAT_SUM", evaluable: true, holds: violations.length === 0, violations };
}

/** C5: all rates come from the configured closed set (plausibility, not arithmetic). */
export function c5VatClosedSet(w: Working, vatRates: number[]): ConstraintCheck {
  const rates: { rate: number; path: string }[] = [];
  w.vat.forEach((v, i) => {
    if (v.rate !== null) rates.push({ rate: v.rate, path: `vatBreakdown.${i}.rate` });
  });
  w.lines.forEach((l, i) => {
    if (l.taxRate !== null) rates.push({ rate: l.taxRate, path: `lineItems.${i}.taxRate` });
  });
  if (rates.length === 0) {
    return { id: "C5_VAT_CLOSED_SET", evaluable: false, holds: false, violations: [] };
  }
  const bad = rates.filter((r) => !vatRates.includes(r.rate));
  return {
    id: "C5_VAT_CLOSED_SET",
    evaluable: true,
    holds: bad.length === 0,
    violations: bad.map((b) => ({
      constraint: "C5_VAT_CLOSED_SET",
      paths: [b.path],
      detail: `VAT rate ${b.rate}% not in the configured set [${vatRates.join(", ")}]`,
    })),
  };
}

export function evaluateAll(
  w: Working,
  tol: Tolerances,
  vatRates: number[],
): ConstraintCheck[] {
  return [
    c1Totals(w, tol),
    c2LineSum(w, tol),
    c3LineMath(w, tol),
    c4VatSum(w, tol),
    c5VatClosedSet(w, vatRates),
  ];
}

export type { Tolerances };
