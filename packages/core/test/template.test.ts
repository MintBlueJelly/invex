import { describe, expect, it } from "vitest";
import {
  applyTemplate,
  extractVendorIds,
  induceTemplate,
  reconcile,
  templateIsUseful,
  type CanonicalInvoice,
  type PositionedLine,
  type PositionedTextDocument,
  type VendorTemplate,
} from "../src/index";

/**
 * Hand-built positioned document mirroring the standard fixture invoice —
 * what the Docling mapper would produce for it (German locale rendering).
 */

function line(text: string, page: number, bbox: [number, number, number, number]): PositionedLine {
  return { text, page, bbox, tokens: [{ text, page, bbox }] };
}

function sampleDoc(): PositionedTextDocument {
  return {
    pageCount: 1,
    lines: [
      line("ACME Bürotechnik GmbH", 1, [0.08, 0.05, 0.4, 0.07]),
      line("Industriestraße 12", 1, [0.08, 0.075, 0.3, 0.09]),
      line("80331 München", 1, [0.08, 0.095, 0.28, 0.11]),
      line("USt-IdNr.: DE811907980", 1, [0.08, 0.115, 0.35, 0.13]),
      line("Rechnung", 1, [0.62, 0.05, 0.78, 0.08]),
      line("Rechnungs-Nr.: R-2026-0042", 1, [0.62, 0.09, 0.95, 0.11]),
      line("Rechnungsdatum: 15.06.2026", 1, [0.62, 0.115, 0.95, 0.135]),
      line("Zwischensumme (netto): 1.148,70 EUR", 1, [0.5, 0.72, 0.95, 0.74]),
      line("MwSt. 19%: 218,25 EUR", 1, [0.5, 0.745, 0.95, 0.765]),
      line("Gesamtbetrag: 1.366,95 EUR", 1, [0.5, 0.77, 0.95, 0.79]),
      line("Bankverbindung: IBAN DE02120300000000202051", 1, [0.08, 0.85, 0.6, 0.87]),
    ],
    tables: [
      {
        page: 1,
        bbox: [0.08, 0.3, 0.95, 0.65],
        headerCells: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
        rows: [
          ["1", "Aktenvernichter PS-500", "2", "199,50", "399,00"],
          ["2", "Wartungsvertrag Bürogeräte, Laufzeit 12", "1", "480,00", "480,00"],
          ["", "Monate", "", "", ""],
          ["3", "Toner-Set CMYK", "3", "89,90", "269,70"],
        ],
      },
    ],
  };
}

function sampleInvoice(): CanonicalInvoice {
  return {
    schemaVersion: 1,
    invoiceNumber: "R-2026-0042",
    issueDate: "2026-06-15",
    dueDate: null,
    currency: "EUR",
    locale: "de-DE",
    seller: {
      name: "ACME Bürotechnik GmbH",
      ustIdNr: "DE811907980",
      steuernummer: null,
      ibans: ["DE02120300000000202051"],
      address: { street: "Industriestraße 12", postalCode: "80331", city: "München", countryCode: "DE" },
    },
    buyer: null,
    totals: { net: "1148.70", tax: "218.25", gross: "1366.95" },
    vatBreakdown: [{ rate: 19, net: "1148.70", tax: "218.25" }],
    lineItems: [
      { position: 1, description: "Aktenvernichter PS-500", quantity: "2", unit: "Stk", unitPrice: "199.50", taxRate: 19, lineTotal: "399.00" },
      { position: 2, description: "Wartungsvertrag Bürogeräte, Laufzeit 12 Monate", quantity: "1", unit: "Stk", unitPrice: "480.00", taxRate: 19, lineTotal: "480.00" },
      { position: 3, description: "Toner-Set CMYK", quantity: "3", unit: "Stk", unitPrice: "89.90", taxRate: 19, lineTotal: "269.70" },
    ],
    paymentTerms: null,
  };
}

describe("vendor identifier extraction", () => {
  it("finds checksum-valid identifiers and the letterhead name", () => {
    const ids = extractVendorIds(sampleDoc());
    expect(ids.ustIdNr).toBe("DE811907980");
    expect(ids.ibans).toEqual(["DE02120300000000202051"]);
    expect(ids.nameGuess).toBe("ACME Bürotechnik GmbH");
    expect(ids.postalCodeGuess).toBe("80331");
    expect(ids.nameHash).toBeTruthy();
  });
});

describe("template induction", () => {
  it("induces locale, anchored header fields, and the line-item table", () => {
    const t = induceTemplate(sampleInvoice(), sampleDoc());
    expect(t.locale.decimal).toBe(",");
    expect(t.locale.dateFormats).toContain("dd.MM.yyyy");
    expect(t.vendorIds.ustIdNr).toBe("DE811907980");
    expect(t.vendorIds.ibans).toEqual(["DE02120300000000202051"]);

    expect(t.fields["invoiceNumber"]?.label).toBe("Rechnungs-Nr.");
    expect(t.fields["invoiceNumber"]?.valuePattern).toBe("R-\\d+-\\d+");
    expect(t.fields["invoiceNumber"]?.region?.page).toBe(1);
    expect(t.fields["totals.gross"]?.label).toBe("Gesamtbetrag");
    expect(t.fields["issueDate"]?.label).toBe("Rechnungsdatum");

    expect(t.lineItemTable?.headerSignature).toEqual(["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"]);
    expect(t.lineItemTable?.columns).toMatchObject({
      position: 0,
      description: 1,
      quantity: 2,
      unitPrice: 3,
      lineTotal: 4,
    });
    expect(t.lineItemTable?.descriptionContinuation).toBe("rowsWithoutPosNumber");
    expect(templateIsUseful(t)).toBe(true);
  });
});

describe("template application (fixed point: induce → apply → reconcile)", () => {
  it("re-extracts the original invoice from the same layout", () => {
    const original = sampleInvoice();
    const doc = sampleDoc();
    const template = induceTemplate(original, doc);

    const { envelope, fieldsHit } = applyTemplate(template, doc);
    expect(fieldsHit).toContain("invoiceNumber");
    expect(fieldsHit).toContain("lineItems");
    expect(envelope.invoice.invoiceNumber).toBe("R-2026-0042");
    expect(envelope.invoice.issueDate).toBe("2026-06-15");
    expect(envelope.invoice.totals?.gross).toBe("1366.95");
    expect(envelope.invoice.lineItems).toHaveLength(3);
    expect(envelope.invoice.lineItems?.[1]?.description).toBe(
      "Wartungsvertrag Bürogeräte, Laufzeit 12 Monate",
    );
    expect(envelope.fieldMeta["invoiceNumber"]?.source).toBe("template");

    // The solver closes the loop: template extraction + repairs = the original.
    const result = reconcile(envelope);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe("reconciled");
    expect(result.invoice?.totals).toEqual(original.totals);
    expect(result.invoice?.vatBreakdown).toEqual(original.vatBreakdown);
    expect(result.invoice?.lineItems.map((l) => l.lineTotal)).toEqual(["399.00", "480.00", "269.70"]);
    expect(result.invoice?.lineItems.every((l) => l.taxRate === 19)).toBe(true);
  });

  it("region-only descriptor works without a label (briefing grandTotal example)", () => {
    const doc = sampleDoc();
    const template: VendorTemplate = {
      templateVersion: 1,
      vendorIds: { displayName: "ACME Bürotechnik GmbH" },
      locale: { decimal: ",", dateFormats: ["dd.MM.yyyy"] },
      fields: {
        "totals.gross": {
          region: { page: -1, bbox: [0.5, 0.76, 1.0, 0.8] },
          valuePattern: "[\\d.,]+,\\d{2}",
        },
      },
    };
    const { envelope } = applyTemplate(template, doc);
    expect(envelope.invoice.totals?.gross).toBe("1366.95");
  });

  it("misses cleanly on a different layout (fieldsMissed reported)", () => {
    const template = induceTemplate(sampleInvoice(), sampleDoc());
    const otherDoc: PositionedTextDocument = {
      pageCount: 1,
      lines: [line("Völlig anderes Layout", 1, [0.1, 0.1, 0.5, 0.12])],
      tables: [],
    };
    const { fieldsHit, fieldsMissed } = applyTemplate(template, otherDoc);
    expect(fieldsHit).toHaveLength(0);
    expect(fieldsMissed.length).toBeGreaterThan(0);
  });
});
