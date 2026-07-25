import Decimal from "decimal.js";
import type { Working } from "./working";
import { moneyStr, qtyStr } from "./working";
import type { Tolerances } from "./constraints";
import type { AppliedRepair, ConstraintViolation } from "./types";

/**
 * Repair rules (briefing §4: the validator is a repair step). Each rule fires only
 * when its target is missing, records what it did, and never overwrites extracted
 * values — repairs fill gaps, they don't fix contradictions (those escalate).
 */

export interface RepairContext {
  repairs: AppliedRepair[];
  vatRates: number[];
  tol: Tolerances;
}

function record(ctx: RepairContext, rule: string, path: string, to: string): void {
  ctx.repairs.push({ rule, path, to });
}

const ZERO = new Decimal(0);

/** Derive missing header totals from a complete VAT breakdown. */
function totalsFromVat(w: Working, ctx: RepairContext): boolean {
  const complete = w.vat.length > 0 && w.vat.every((v) => v.net !== null && v.tax !== null);
  if (!complete) return false;
  let fired = false;
  if (w.net === null) {
    w.net = w.vat.reduce((a, v) => a.plus(v.net as Decimal), ZERO).toDecimalPlaces(2);
    record(ctx, "R_TOTALS_FROM_VAT", "totals.net", moneyStr(w.net));
    fired = true;
  }
  if (w.tax === null) {
    w.tax = w.vat.reduce((a, v) => a.plus(v.tax as Decimal), ZERO).toDecimalPlaces(2);
    record(ctx, "R_TOTALS_FROM_VAT", "totals.tax", moneyStr(w.tax));
    fired = true;
  }
  return fired;
}

/** Derive missing totals.net from complete line totals. */
function netFromLines(w: Working, ctx: RepairContext): boolean {
  if (w.net !== null || w.lines.length === 0) return false;
  if (w.lines.some((l) => l.lineTotal === null)) return false;
  w.net = w.lines.reduce((a, l) => a.plus(l.lineTotal as Decimal), ZERO).toDecimalPlaces(2);
  record(ctx, "R_NET_FROM_LINES", "totals.net", moneyStr(w.net));
  return true;
}

/** Exactly one of net/tax/gross missing → derive from the other two. */
function totalDerive(w: Working, ctx: RepairContext): boolean {
  const missing = [w.net, w.tax, w.gross].filter((v) => v === null).length;
  if (missing !== 1) return false;
  if (w.net === null) {
    w.net = (w.gross as Decimal).minus(w.tax as Decimal);
    record(ctx, "R_TOTAL_DERIVE", "totals.net", moneyStr(w.net));
  } else if (w.tax === null) {
    w.tax = (w.gross as Decimal).minus(w.net);
    record(ctx, "R_TOTAL_DERIVE", "totals.tax", moneyStr(w.tax));
  } else {
    w.gross = w.net.plus(w.tax as Decimal);
    record(ctx, "R_TOTAL_DERIVE", "totals.gross", moneyStr(w.gross));
  }
  return true;
}

/**
 * Synthesize a single-entry VAT breakdown when none was extracted but net/tax
 * uniquely match one closed-set rate; also complete partial entries.
 */
function vatSynth(w: Working, ctx: RepairContext): boolean {
  let fired = false;

  if (w.vat.length === 0 && w.net !== null && w.tax !== null) {
    const matches = ctx.vatRates.filter((r) =>
      w.net!.times(r).div(100).minus(w.tax!).abs().lte(ctx.tol.header),
    );
    if (matches.length === 1) {
      const rate = matches[0]!;
      w.vat.push({ rate, net: w.net, tax: w.tax });
      record(ctx, "R_VAT_SYNTH", "vatBreakdown.0", `{rate: ${rate}, net: ${moneyStr(w.net)}, tax: ${moneyStr(w.tax)}}`);
      fired = true;
    }
  }

  w.vat.forEach((v, i) => {
    if (v.rate === null) return;
    if (v.tax === null && v.net !== null) {
      v.tax = v.net.times(v.rate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      record(ctx, "R_VAT_SYNTH", `vatBreakdown.${i}.tax`, moneyStr(v.tax));
      fired = true;
    } else if (v.net === null && v.tax !== null && v.rate > 0) {
      v.net = v.tax.times(100).div(v.rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      record(ctx, "R_VAT_SYNTH", `vatBreakdown.${i}.net`, moneyStr(v.net));
      fired = true;
    }
  });

  // A rate-0 entry cannot be completed from its own tax — net x 0% = 0 holds for
  // ANY net, so the relation is underdetermined and the loop above skips it.
  // Apportion from the header instead: if exactly one entry still lacks a net,
  // it is whatever the others do not account for.
  //
  // Without this every §19 Kleinunternehmer and §13b reverse-charge invoice
  // escalated, because runRuleEngine emits {rate, tax, net: null} and those
  // documents are precisely the ones whose only rate is 0 (INVEX-010).
  if (w.net !== null) {
    const missing = w.vat.filter((v) => v.net === null);
    if (missing.length === 1) {
      const accounted = w.vat.reduce(
        (sum, v) => (v.net === null ? sum : sum.plus(v.net)),
        new Decimal(0),
      );
      const entry = missing[0]!;
      entry.net = w.net.minus(accounted);
      record(ctx, "R_VAT_SYNTH", `vatBreakdown.${w.vat.indexOf(entry)}.net`, moneyStr(entry.net));
      fired = true;
    }
  }

  return fired;
}

/** Missing lineTotal → quantity × unitPrice. */
function lineTotalDerive(w: Working, ctx: RepairContext): boolean {
  let fired = false;
  w.lines.forEach((l, i) => {
    if (l.lineTotal !== null || l.quantity === null || l.unitPrice === null) return;
    l.lineTotal = l.quantity.times(l.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    record(ctx, "R_LINETOTAL_DERIVE", `lineItems.${i}.lineTotal`, moneyStr(l.lineTotal));
    fired = true;
  });
  return fired;
}

/** Missing unitPrice → lineTotal ÷ quantity (briefing §4). */
function unitPriceDerive(w: Working, ctx: RepairContext): boolean {
  let fired = false;
  w.lines.forEach((l, i) => {
    if (l.unitPrice !== null || l.quantity === null || l.lineTotal === null) return;
    if (l.quantity.isZero()) return;
    l.unitPrice = l.lineTotal.div(l.quantity).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    record(ctx, "R_UNITPRICE_DERIVE", `lineItems.${i}.unitPrice`, qtyStr(l.unitPrice));
    fired = true;
  });
  return fired;
}

/**
 * Missing quantity → derive lineTotal ÷ unitPrice when it verifies (general form
 * of the over-determination), else default 1 verified via unitPrice × 1 = lineTotal
 * (briefing §4), else default 1 when the line only has a total.
 */
function qtyRepair(w: Working, ctx: RepairContext): boolean {
  let fired = false;
  w.lines.forEach((l, i) => {
    if (l.quantity !== null) return;
    if (l.unitPrice !== null && l.lineTotal !== null && !l.unitPrice.isZero()) {
      const q = l.lineTotal.div(l.unitPrice).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      if (q.times(l.unitPrice).minus(l.lineTotal).abs().lte(ctx.tol.line)) {
        l.quantity = q;
        const rule = q.eq(1) ? "R_QTY_DEFAULT" : "R_QTY_DERIVE";
        record(ctx, rule, `lineItems.${i}.quantity`, qtyStr(q));
        fired = true;
      }
      return;
    }
    if (l.unitPrice === null && l.lineTotal !== null) {
      // qty=1; unitPrice follows as lineTotal/1 on the next pass.
      l.quantity = new Decimal(1);
      record(ctx, "R_QTY_DEFAULT", `lineItems.${i}.quantity`, "1");
      fired = true;
    }
  });
  return fired;
}

/**
 * Missing per-line tax rate: inherit from the document-level VAT breakdown —
 * SINGLE-RATE documents only (user decision; the multi-rate assignment is
 * subset-sum and escalates instead). Cross-checked against the tax sum.
 */
function lineTaxInherit(w: Working, ctx: RepairContext): boolean {
  const distinctRates = [...new Set(w.vat.map((v) => v.rate).filter((r): r is number => r !== null))];
  if (distinctRates.length !== 1) return false;
  const rate = distinctRates[0]!;
  const missing = w.lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.taxRate === null);
  if (missing.length === 0) return false;

  // Cross-check (briefing §4): with the inherited rate on ALL lines, the implied
  // tax must match the document tax — only checkable when line totals are complete.
  if (w.tax !== null && w.lines.every((l) => l.lineTotal !== null)) {
    const implied = w.lines
      .reduce(
        (a, l) => a.plus((l.lineTotal as Decimal).times(l.taxRate ?? rate).div(100)),
        ZERO,
      )
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const tolerance = ctx.tol.header.plus(ctx.tol.lineSumSlackPerLine.times(w.lines.length));
    if (implied.minus(w.tax).abs().gt(tolerance)) return false;
  }

  for (const { l, i } of missing) {
    l.taxRate = rate;
    record(ctx, "R_LINE_TAX_INHERIT", `lineItems.${i}.taxRate`, String(rate));
  }
  return true;
}

/** One full repair pass; returns whether anything fired. */
export function repairPass(w: Working, ctx: RepairContext): boolean {
  let fired = false;
  fired = totalsFromVat(w, ctx) || fired;
  fired = netFromLines(w, ctx) || fired;
  fired = totalDerive(w, ctx) || fired;
  fired = vatSynth(w, ctx) || fired;
  fired = lineTotalDerive(w, ctx) || fired;
  fired = unitPriceDerive(w, ctx) || fired;
  fired = qtyRepair(w, ctx) || fired;
  fired = lineTaxInherit(w, ctx) || fired;
  return fired;
}

/** Post-repair structural gaps that block acceptance (they escalate). */
export function unresolvedViolations(w: Working): ConstraintViolation[] {
  const out: ConstraintViolation[] = [];
  w.lines.forEach((l, i) => {
    if (l.lineTotal === null) {
      out.push({
        constraint: "LINE_TOTAL_UNRESOLVED",
        paths: [`lineItems.${i}.lineTotal`],
        detail: `line ${i} ("${l.description.slice(0, 40)}") has no line total and none could be derived`,
      });
    }
  });
  const distinctRates = [...new Set(w.vat.map((v) => v.rate).filter((r): r is number => r !== null))];
  if (distinctRates.length > 1) {
    w.lines.forEach((l, i) => {
      if (l.taxRate === null) {
        out.push({
          constraint: "LINE_TAX_UNRESOLVED",
          paths: [`lineItems.${i}.taxRate`],
          detail: `line ${i} has no tax rate and the document has ${distinctRates.length} VAT rates — assignment is ambiguous`,
        });
      }
    });
  }
  return out;
}
