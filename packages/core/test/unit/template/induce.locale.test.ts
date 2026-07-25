import { describe, expect, it } from "vitest";
import { applyTemplate, induceTemplate, reconcile } from "../../../src/index";
import type { PositionedTextDocument } from "../../../src/positioned/model";
import { doc, line } from "../../utils/positionedBuilders";
import { invoice } from "../../utils/invoices";

/**
 * INVEX-001 — template locale induction.
 *
 * A template is persisted per vendor and reused for every future invoice from
 * them, so a mis-detected decimal separator is not a one-document error: it is a
 * permanent, silent 100x multiplier on that vendor's amounts, and the resulting
 * invoice still reconciles cleanly (net + tax = gross holds when every term is
 * scaled), so nothing escalates and nobody is told.
 *
 * The design constraint: some renderings are AMBIGUOUS. "1000" ungrouped is
 * identical in both locales. Only a rendering the other locale cannot produce
 * may decide the question.
 */

/** An English-locale invoice page: dot decimals, ISO dates. */
function enDoc(grossText: string, netText: string, taxText: string): PositionedTextDocument {
  return doc([
    line("ACME Office Supplies Ltd", { y: 0.05 }),
    line("Invoice No INV-2026-0042", { y: 0.12 }),
    line("Invoice Date 2026-06-15", { y: 0.16 }),
    line(`Subtotal ${netText}`, { y: 0.7 }),
    line(`VAT 19% ${taxText}`, { y: 0.74 }),
    line(`Total ${grossText}`, { y: 0.78 }),
  ]);
}

/** A German-locale invoice page: comma decimals, dotted dates. */
function deDoc(grossText: string, netText: string, taxText: string): PositionedTextDocument {
  return doc([
    line("ACME Bürotechnik GmbH", { y: 0.05 }),
    line("Rechnungs-Nr. R-2026-0042", { y: 0.12 }),
    line("Rechnungsdatum 15.06.2026", { y: 0.16 }),
    line(`Zwischensumme ${netText}`, { y: 0.7 }),
    line(`MwSt. 19% ${taxText}`, { y: 0.74 }),
    line(`Gesamtbetrag ${grossText}`, { y: 0.78 }),
  ]);
}

const enInvoice = invoice({
  invoiceNumber: "INV-2026-0042",
  seller: {
    name: "ACME Office Supplies Ltd",
    ustIdNr: null,
    steuernummer: null,
    ibans: [],
    address: { street: null, postalCode: null, city: null, countryCode: "GB" },
  },
});

describe("induceTemplate — decimal separator detection", () => {
  it("detects ',' from a grouped German page", () => {
    const d = deDoc("1.366,95", "1.148,70", "218,25");
    expect(induceTemplate(invoice(), d).locale.decimal).toBe(",");
  });

  it("detects ',' from an ungrouped German page", () => {
    const d = deDoc("1366,95", "1148,70", "218,25");
    expect(induceTemplate(invoice(), d).locale.decimal).toBe(",");
  });

  it("detects '.' from a grouped English page", () => {
    const d = enDoc("1,366.95", "1,148.70", "218.25");
    expect(induceTemplate(enInvoice, d).locale.decimal).toBe(".");
  });

  it("detects '.' from an UNGROUPED English page", () => {
    // The regression: the raw dot-decimal form was a member of the ','
    // candidate set, so this page matched on the ',' branch first and the
    // template was induced with the wrong separator.
    const d = enDoc("1366.95", "1148.70", "218.25");
    expect(induceTemplate(enInvoice, d).locale.decimal).toBe(".");
  });

  it("re-applying an induced template reproduces the printed amounts, not 100x them", () => {
    // The end-to-end proof of INVEX-001. Asserted on the applied envelope rather
    // than a reconciled invoice: this page carries no line-item table, so the
    // solver legitimately cannot close it. What matters here is the numbers the
    // template reads back off the page.
    const d = enDoc("1366.95", "1148.70", "218.25");
    const template = induceTemplate(enInvoice, d);

    const { envelope } = applyTemplate(template, d);

    expect(envelope.invoice.totals).toEqual({
      net: "1148.70",
      tax: "218.25",
      gross: "1366.95",
    });
  });

  it("refuses to anchor an amount whose text does not parse back to it", () => {
    // Belt and braces: even if separator detection were wrong, the round-trip
    // guard drops the field rather than persisting a 100x anchor.
    const d = enDoc("1366.95", "1148.70", "218.25");
    const template = induceTemplate(enInvoice, d);
    for (const key of ["totals.gross", "totals.net", "totals.tax"] as const) {
      expect(template.fields[key], `${key} should be anchored`).toBeDefined();
    }
    expect(template.locale.decimal).toBe(".");
  });

});

describe("why the 100x error was invisible (and only partly caught downstream)", () => {
  const scaled = (net: string, tax: string, gross: string) =>
    reconcile({
      invoice: {
        ...invoice(),
        totals: { net, tax, gross },
        vatBreakdown: [{ rate: 19, net, tax }],
        lineItems: [
          { position: 1, description: "Service", quantity: "1", unit: null, unitPrice: net, taxRate: 19, lineTotal: net },
        ],
      },
      fieldMeta: {},
    });

  it("catches the scaled error when the VAT arithmetic has a rounding residue", () => {
    // 1148.70 x 19% = 218.253, printed as 218.25 — a 0.003 residue. Scaled by
    // 100 that residue becomes 0.3, which blows C4's ABSOLUTE +/-0.02 tolerance.
    // An accidental safety net: it works only because tolerances are absolute.
    expect(scaled("1148.70", "218.25", "1366.95").status).toBe("reconciled");
    const bad = scaled("114870", "21825", "136695");
    expect(bad.status).toBe("failed");
    expect(bad.violations.map((v) => v.constraint)).toContain("C4_VAT_SUM");
  });

  it("does NOT catch it when the VAT arithmetic is exact — the silent case", () => {
    // 1000.00 x 19% = 190.00 exactly. There is no residue to scale, so every
    // constraint still holds and a 100x-wrong invoice commits with zero
    // violations and full "template" provenance. Round net amounts are common,
    // so this is not a corner case — it is why the fix belongs at induction.
    expect(scaled("1000.00", "190.00", "1190.00").status).toBe("reconciled");
    const silent = scaled("100000", "19000", "119000");
    expect(silent.status).toBe("reconciled");
    expect(silent.violations).toEqual([]);
  });
});

describe("induceTemplate — ambiguous renderings must not decide the locale", () => {
  it("falls back to the ',' default when every printed amount is locale-neutral", () => {
    // "1000"/"190"/"1190" render identically under both locales, so there is no
    // evidence either way. The default is a documented guess, not a detection.
    const neutral = invoice({
      totals: { net: "1000", tax: "190", gross: "1190" },
      vatBreakdown: [{ rate: 19, net: "1000", tax: "190" }],
      lineItems: [
        { position: 1, description: "Service", quantity: "1", unit: null, unitPrice: "1000", taxRate: 19, lineTotal: "1000" },
      ],
    });
    const d = deDoc("1190", "1000", "190");
    expect(induceTemplate(neutral, d).locale.decimal).toBe(",");
  });

  it("uses a later amount when the first one is ambiguous", () => {
    // gross "1190" is neutral; tax "218.25" is not. Detection must keep looking
    // rather than settling on the default from the first probe.
    const mixed = invoice({
      totals: { net: "971.75", tax: "218.25", gross: "1190" },
      vatBreakdown: [{ rate: 19, net: "971.75", tax: "218.25" }],
      lineItems: [
        { position: 1, description: "Service", quantity: "1", unit: null, unitPrice: "971.75", taxRate: 19, lineTotal: "971.75" },
      ],
    });
    const d = enDoc("1190", "971.75", "218.25");
    expect(induceTemplate(mixed, d).locale.decimal).toBe(".");
  });
});
