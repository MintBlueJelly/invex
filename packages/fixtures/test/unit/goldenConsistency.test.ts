import { zCanonicalInvoice, type CanonicalInvoice } from "@invex/core";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { loadGoldens, type Golden } from "../../src/goldens";
import type { LiteralInvoiceDoc } from "../../src/literal/spec";

/**
 * A hand-authored oracle can have typos. These guards VERIFY the goldens; they
 * never DERIVE them — the direction matters.
 *
 * Everything below is written inline and shared with nothing. In particular it
 * does not import computeInvoice, or any of the arithmetic in src/, because a
 * check that reuses the code it is checking proves only that the code agrees
 * with itself. That is precisely the failure this whole phase exists to remove.
 */

const D = (s: string) => new Decimal(s);
const near = (a: Decimal, b: Decimal, tol: string) => a.minus(b).abs().lte(new Decimal(tol));

/** Independent, three-line locale parser — deliberately not parseAmount(). */
function printedToDot(text: string, locale: "de" | "en"): string | null {
  const bare = text.replace(/[^\d.,-]/g, "");
  if (bare === "" || !/\d/.test(bare)) return null;
  const dot = locale === "de" ? bare.replace(/\./g, "").replace(",", ".") : bare.replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(dot) ? new Decimal(dot).toFixed(2) : null;
}

const goldens = loadGoldens();
const invoiceGoldens = goldens.filter((g): g is Golden & { expected: { canonical: CanonicalInvoice } } =>
  g.expected.canonical !== null,
);
/** Only a synthetic scenario has a printed page to compare the expectation against. */
const printedGoldens = invoiceGoldens.filter(
  (g): g is typeof g & { render: { doc: LiteralInvoiceDoc } } => g.render?.doc !== undefined,
);

describe("golden scenarios", () => {
  it("there are scenarios to check", () => {
    expect(goldens.length).toBeGreaterThan(0);
  });

  it.each(goldens.map((g) => [g.id, g] as const))("%s: has a title and an author date", (_id, g) => {
    expect(g.title.length).toBeGreaterThan(10);
    expect(g.authoredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("committed canonical invoices are internally sound", () => {
  it.each(invoiceGoldens.map((g) => [g.id, g] as const))("%s: satisfies the canonical schema", (_id, g) => {
    const parsed = zCanonicalInvoice.safeParse(g.expected.canonical);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  });

  it.each(invoiceGoldens.map((g) => [g.id, g] as const))("%s: quantity x unitPrice = lineTotal", (_id, g) => {
    for (const l of g.expected.canonical.lineItems) {
      if (l.quantity === null || l.unitPrice === null || l.lineTotal === null) continue;
      expect(
        near(D(l.quantity).times(l.unitPrice), D(l.lineTotal), "0.005"),
        `${l.description}: ${l.quantity} x ${l.unitPrice} != ${l.lineTotal}`,
      ).toBe(true);
    }
  });

  it.each(invoiceGoldens.map((g) => [g.id, g] as const))("%s: line totals sum to each VAT rate's net", (_id, g) => {
    const inv = g.expected.canonical;
    const byRate = new Map<number, Decimal>();
    for (const l of inv.lineItems) {
      if (l.lineTotal === null || l.taxRate === null) continue;
      byRate.set(l.taxRate, (byRate.get(l.taxRate) ?? new Decimal(0)).plus(l.lineTotal));
    }
    for (const [rate, sum] of byRate) {
      const entry = inv.vatBreakdown.find((v) => v.rate === rate);
      expect(entry, `no vatBreakdown entry for rate ${rate}`).toBeDefined();
      expect(near(sum, D(entry!.net), "0.01"), `rate ${rate}: lines ${sum} != vat.net ${entry!.net}`).toBe(true);
    }
  });

  it.each(invoiceGoldens.map((g) => [g.id, g] as const))("%s: vat.net x rate = vat.tax", (_id, g) => {
    for (const v of g.expected.canonical.vatBreakdown) {
      const expectedTax = D(v.net).times(v.rate).div(100);
      expect(near(expectedTax, D(v.tax), "0.01"), `rate ${v.rate}: ${v.net} x ${v.rate}% != ${v.tax}`).toBe(true);
    }
  });

  it.each(invoiceGoldens.map((g) => [g.id, g] as const))("%s: VAT rows sum to the totals", (_id, g) => {
    const inv = g.expected.canonical;
    const net = inv.vatBreakdown.reduce((s, v) => s.plus(v.net), new Decimal(0));
    const tax = inv.vatBreakdown.reduce((s, v) => s.plus(v.tax), new Decimal(0));
    expect(near(net, D(inv.totals.net), "0.01"), `vat net ${net} != totals.net ${inv.totals.net}`).toBe(true);
    expect(near(tax, D(inv.totals.tax), "0.01"), `vat tax ${tax} != totals.tax ${inv.totals.tax}`).toBe(true);
  });

  it.each(invoiceGoldens.map((g) => [g.id, g] as const))("%s: net + tax = gross", (_id, g) => {
    const t = g.expected.canonical.totals;
    expect(near(D(t.net).plus(t.tax), D(t.gross), "0.005"), `${t.net} + ${t.tax} != ${t.gross}`).toBe(true);
  });
});

describe("the printed page and the expectation agree", () => {
  // Real-PDF scenarios are excluded: their page is the PDF, not a literal doc.
  /**
   * The guard that catches "you edited the PDF text and forgot the
   * expectation". Every amount printed on the page must appear somewhere in the
   * canonical invoice, and every canonical amount must be printed.
   */
  it.each(printedGoldens.map((g) => [g.id, g] as const))("%s: every printed amount appears in the canonical", (_id, g) => {
    const doc = g.render.doc;
    const printed = new Set<string>();
    for (const l of doc.lines) {
      for (const t of [l.unitPriceText, l.lineTotalText]) {
        const v = t ? printedToDot(t, doc.locale) : null;
        if (v) printed.add(v);
      }
    }
    for (const t of doc.totalsBlock) {
      const v = printedToDot(t.valueText, doc.locale);
      if (v) printed.add(v);
    }

    const inv = g.expected.canonical;
    const canonical = new Set<string>();
    for (const s of [inv.totals.net, inv.totals.tax, inv.totals.gross]) canonical.add(D(s).toFixed(2));
    for (const v of inv.vatBreakdown) for (const s of [v.net, v.tax]) canonical.add(D(s).toFixed(2));
    for (const l of inv.lineItems) {
      for (const s of [l.unitPrice, l.lineTotal]) if (s !== null) canonical.add(D(s).toFixed(2));
    }

    const missing = [...printed].filter((p) => !canonical.has(p));
    expect(missing, `printed but absent from the canonical invoice`).toEqual([]);
  });

  it.each(printedGoldens.map((g) => [g.id, g] as const))("%s: header fields are printed as the canonical states", (_id, g) => {
    const printedValues = g.render.doc.headerFields.map((f) => f.valueText);
    expect(printedValues).toContain(g.expected.canonical.invoiceNumber);
  });

  it.each(printedGoldens.map((g) => [g.id, g] as const))("%s: the seller name is printed verbatim", (_id, g) => {
    expect(g.render.doc.seller.nameText).toBe(g.expected.canonical.seller.name);
  });

  it.each(printedGoldens.map((g) => [g.id, g] as const))("%s: one canonical line item per printed row", (_id, g) => {
    expect(g.expected.canonical.lineItems).toHaveLength(g.render.doc.lines.length);
  });
});
