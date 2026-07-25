import { describe, expect, it } from "vitest";
import { applyTemplateOcr } from "../../../src/index";
import type { PositionedTextDocument } from "../../../src/positioned/model";
import type { VendorTemplate } from "../../../src/template/types";
import { columnLine } from "../../utils/positionedBuilders";

/**
 * INVEX-002 — column assignment on OCR output (Path C).
 *
 * Path C has no TableFormer tables, so line items are rebuilt by matching the
 * header signature and deriving column x-bands from the header tokens. The
 * geometry that breaks it is entirely ordinary: amount columns are RIGHT
 * aligned, so a wide value starts to the left of its own header. When it is
 * pushed into the previous column, parseAmount does not reject the merged cell
 * — it concatenates the digits into a plausible number.
 */

const HEADER_X = { pos: 0.05, desc: 0.12, qty: 0.5, unitPrice: 0.62, lineTotal: 0.8 };

const template: VendorTemplate = {
  templateVersion: 1,
  vendorIds: { displayName: "ACME Bürotechnik GmbH", nameHash: "abc123" },
  locale: { decimal: ",", dateFormats: ["dd.MM.yyyy"] },
  fields: {},
  lineItemTable: {
    headerSignature: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
    columns: { position: 0, description: 1, quantity: 2, unitPrice: 3, lineTotal: 4 },
    descriptionContinuation: "rowsWithoutPosNumber",
  },
};

/**
 * `overhang` pushes the amount tokens left of their header start, which is what
 * right alignment does to any value wider than its header label.
 */
function scannedDoc(overhang: number): PositionedTextDocument {
  const header = columnLine(
    [
      { text: "Pos", x: HEADER_X.pos, width: 0.04 },
      { text: "Bezeichnung", x: HEADER_X.desc, width: 0.16 },
      { text: "Menge", x: HEADER_X.qty, width: 0.07 },
      { text: "Einzelpreis", x: HEADER_X.unitPrice, width: 0.12 },
      { text: "Gesamt", x: HEADER_X.lineTotal, width: 0.09 },
    ],
    { y: 0.4 },
  );
  const row = (y: number, pos: string, desc: string, qty: string, unit: string, total: string) =>
    columnLine(
      [
        { text: pos, x: HEADER_X.pos, width: 0.02 },
        { text: desc, x: HEADER_X.desc, width: 0.2 },
        { text: qty, x: HEADER_X.qty, width: 0.02 },
        { text: unit, x: HEADER_X.unitPrice - overhang, width: 0.12 },
        { text: total, x: HEADER_X.lineTotal - overhang, width: 0.14 },
      ],
      { y },
    );
  return {
    pageCount: 1,
    tables: [],
    lines: [
      header,
      row(0.46, "1", "Aktenvernichter", "2", "199,50", "399,00"),
      row(0.52, "2", "Tonerset", "3", "89,90", "269,70"),
      columnLine([{ text: "Gesamtbetrag 1.366,95", x: 0.6, width: 0.3 }], { y: 0.62 }),
    ],
  };
}

describe("applyTemplateOcr — right-aligned amount columns", () => {
  it("keeps columns separate when values sit inside their header start", () => {
    const items = applyTemplateOcr(template, scannedDoc(0)).envelope.invoice.lineItems;
    expect(items).toHaveLength(2);
    expect(items?.[0]).toMatchObject({ description: "Aktenvernichter", quantity: "2", unitPrice: "199.50", lineTotal: "399.00" });
  });

  it("keeps columns separate when values overhang their header by 0.04 of the page", () => {
    // ~17pt on A4 — an entirely normal overhang for "1.234,56" under a "Gesamt"
    // header. The old left-tolerance was a flat 0.02, so this bled one column left.
    const items = applyTemplateOcr(template, scannedDoc(0.04)).envelope.invoice.lineItems;
    expect(items).toHaveLength(2);
    expect(items?.[0]).toMatchObject({
      description: "Aktenvernichter",
      quantity: "2",
      unitPrice: "199.50",
      lineTotal: "399.00",
    });
    expect(items?.[1]).toMatchObject({ unitPrice: "89.90", lineTotal: "269.70" });
  });

  it("reads the same values regardless of how far the amounts overhang", () => {
    // The full shape, at every overhang. The failure was not a lost cell: the
    // whole row shifted one column left, so quantity became "2199.50" (the
    // quantity fused with the unit price) and unitPrice silently held the LINE
    // TOTAL. Every value was schema-valid; the solver would then derive a
    // lineTotal from 2199.50 x 399.00. Asserting the full row is what catches a
    // shift — a per-field plausibility check does not.
    const expected = [
      { position: 1, description: "Aktenvernichter", quantity: "2", unitPrice: "199.50", lineTotal: "399.00" },
      { position: 2, description: "Tonerset", quantity: "3", unitPrice: "89.90", lineTotal: "269.70" },
    ];
    for (const overhang of [0, 0.02, 0.04, 0.06]) {
      const items = applyTemplateOcr(template, scannedDoc(overhang)).envelope.invoice.lineItems;
      expect(items, `overhang ${overhang}`).toHaveLength(2);
      expect(items?.[0], `overhang ${overhang} row 1`).toMatchObject(expected[0]!);
      expect(items?.[1], `overhang ${overhang} row 2`).toMatchObject(expected[1]!);
    }
  });
});
