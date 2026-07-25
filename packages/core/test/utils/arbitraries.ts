import Decimal from "decimal.js";
import fc from "fast-check";
import type { CandidateInvoice } from "../../src/schema/candidate";

/**
 * Shared fast-check arbitraries.
 *
 * Values are generated as decimal STRINGS throughout, never floats — the same
 * discipline the production code follows, and for the same reason: a property
 * that generates 0.1 + 0.2 as a float would fail for a reason that has nothing
 * to do with the code under test.
 */

const D = (v: string | number) => new Decimal(v);
const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** A monetary amount as a dot-decimal string with exactly 2 decimals. */
export function arbMoney(opts: { min?: number; max?: number } = {}): fc.Arbitrary<string> {
  const min = opts.min ?? 0;
  const max = opts.max ?? 1_000_000;
  return fc
    .integer({ min: Math.round(min * 100), max: Math.round(max * 100) })
    .map((cents) => money(D(cents).div(100)));
}

/** A quantity: 1–4 decimals, as real invoices print. */
export function arbQuantity(): fc.Arbitrary<string> {
  return fc.integer({ min: 1, max: 100_000 }).map((n) => D(n).div(100).toFixed(2));
}

/** The German closed set (config: reconcile.vatRates). Includes 0 deliberately. */
export function arbVatRate(): fc.Arbitrary<number> {
  return fc.constantFrom(19, 7, 0);
}

export interface ConsistentInvoice {
  invoice: CandidateInvoice;
  /** The exact values, so a property can assert reconstruction rather than re-derive. */
  truth: {
    lines: { quantity: string; unitPrice: string; lineTotal: string; taxRate: number }[];
    vat: { rate: number; net: string; tax: string }[];
    totals: { net: string; tax: string; gross: string };
  };
}

/**
 * An invoice whose arithmetic closes EXACTLY — no rounding residue anywhere.
 *
 * Line totals are generated first and the unit price derived from them, so
 * quantity x unitPrice = lineTotal holds to the cent rather than approximately.
 * The VAT amounts are likewise built to be exact, because the point of the
 * erasure property is to test the SOLVER, not to rediscover that 19% of an
 * arbitrary number does not land on a cent boundary.
 */
export function arbConsistentInvoice(): fc.Arbitrary<ConsistentInvoice> {
  return fc
    .array(
      fc.record({
        // Line totals divisible by 100 cents keep unitPrice exact for any qty.
        units: fc.integer({ min: 1, max: 20 }),
        perUnitCents: fc.integer({ min: 100, max: 500_00 }),
        // Nets that are whole euros keep 19% and 7% exact to the cent.
        rate: arbVatRate(),
      }),
      { minLength: 1, maxLength: 6 },
    )
    .map((rows) => {
      const lines = rows.map((r) => {
        const quantity = String(r.units);
        const unitPrice = money(D(r.perUnitCents).div(100));
        const lineTotal = money(D(r.perUnitCents).times(r.units).div(100));
        return { quantity, unitPrice, lineTotal, taxRate: r.rate };
      });

      const byRate = new Map<number, Decimal>();
      for (const l of lines) {
        byRate.set(l.taxRate, (byRate.get(l.taxRate) ?? D(0)).plus(l.lineTotal));
      }
      const vat = [...byRate.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([rate, net]) => ({
          rate,
          net: money(net),
          tax: money(net.times(rate).div(100)),
        }));

      const net = vat.reduce((s, v) => s.plus(v.net), D(0));
      const tax = vat.reduce((s, v) => s.plus(v.tax), D(0));
      const totals = { net: money(net), tax: money(tax), gross: money(net.plus(tax)) };

      const invoice: CandidateInvoice = {
        invoiceNumber: "R-PROP-1",
        issueDate: "2026-06-15",
        currency: "EUR",
        seller: { name: "Prop GmbH" },
        totals,
        vatBreakdown: vat,
        lineItems: lines.map((l, i) => ({
          position: i + 1,
          description: `Position ${i + 1}`,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRate: l.taxRate,
          lineTotal: l.lineTotal,
        })),
      };

      return { invoice, truth: { lines, vat, totals } };
    });
}

/** Which recoverable fields to blank before handing the invoice to the solver. */
export interface ErasureMask {
  quantity: boolean;
  unitPrice: boolean;
  lineTotal: boolean;
  headerTax: boolean;
  headerGross: boolean;
  vatNet: boolean;
}

export function arbErasureMask(): fc.Arbitrary<ErasureMask> {
  return fc.record({
    quantity: fc.boolean(),
    unitPrice: fc.boolean(),
    lineTotal: fc.boolean(),
    headerTax: fc.boolean(),
    headerGross: fc.boolean(),
    vatNet: fc.boolean(),
  });
}

/**
 * Blank the masked fields. Never blanks BOTH operands of a derivation — that
 * would make the value genuinely unrecoverable and the property would be
 * asserting clairvoyance rather than arithmetic.
 */
export function applyMask(inv: CandidateInvoice, mask: ErasureMask): CandidateInvoice {
  // JSON clone rather than structuredClone: core's tsconfig sets types: []
  // and lib ES2023, so the global is not declared. solver.ts clones the same way.
  const out = JSON.parse(JSON.stringify(inv)) as CandidateInvoice;

  for (const l of out.lineItems ?? []) {
    // qty x price = total: at most one of the three may go.
    if (mask.lineTotal) l.lineTotal = null;
    else if (mask.unitPrice) l.unitPrice = null;
    else if (mask.quantity) l.quantity = null;
  }
  // net + tax = gross: at most one of the two derived terms may go.
  if (out.totals) {
    if (mask.headerTax) out.totals.tax = null;
    else if (mask.headerGross) out.totals.gross = null;
  }
  // Only erase VAT nets when a SINGLE rate is present. With two or more rates
  // and every net missing, the header net no longer determines them: 19% tax of
  // 2.20 is consistent with a net of 11.58, 11.59 or 11.60, so the value is
  // underdetermined rather than derivable. Erasing it anyway would make the
  // property demand clairvoyance instead of arithmetic.
  if (mask.vatNet && (out.vatBreakdown?.length ?? 0) === 1) {
    for (const v of out.vatBreakdown ?? []) v.net = null;
  }
  return out;
}
