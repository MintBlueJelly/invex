import { describe, expect, it } from "vitest";
import { applyTemplate, matchTable } from "../../../src/index";
import type { PositionedTextDocument } from "../../../src/positioned/model";
import type { LineItemTableDescriptor, VendorTemplate } from "../../../src/template/types";
import { knownBug } from "../../../../../test-utils/knownBug";
import { columnLine, doc, line, table } from "../../utils/positionedBuilders";

/**
 * `matchTable` and `findField` are the deterministic fast path (briefing §3):
 * once a vendor has a template, these two functions decide the anchors for
 * every future invoice from that vendor with NO further review. A wrong
 * match here is not a crash — it is a fully-confident, wrong invoice.
 */

function baseTemplate(
  fields: VendorTemplate["fields"],
  lineItemTable?: LineItemTableDescriptor,
): VendorTemplate {
  return {
    templateVersion: 1,
    vendorIds: {},
    locale: { decimal: ",", dateFormats: ["dd.MM.yyyy"] },
    fields,
    ...(lineItemTable ? { lineItemTable } : {}),
  };
}

describe("matchTable", () => {
  const signature = ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"];

  it("matches an exact header signature", () => {
    const t = table(signature, [["1", "Aktenvernichter", "2", "199,50", "399,00"]]);
    expect(matchTable([t], { headerSignature: signature, columns: {}, descriptionContinuation: "none" })).toBe(t);
  });

  it("matches with one header cell missing, just above the 0.7 threshold (3/4 = 0.75)", () => {
    const sig4 = ["A", "B", "C", "D"];
    const t = table(["A", "B", "C"], []); // "D" absent
    expect(matchTable([t], { headerSignature: sig4, columns: {}, descriptionContinuation: "none" })).toBe(t);
  });

  it("rejects one header cell missing, just below the 0.7 threshold (2/3 = 0.667)", () => {
    const sig3 = ["A", "B", "C"];
    const t = table(["A", "B"], []); // "C" absent
    expect(matchTable([t], { headerSignature: sig3, columns: {}, descriptionContinuation: "none" })).toBeNull();
  });

  it("returns null when no signature cell is present", () => {
    const t = table(["Foo", "Bar"], []);
    expect(matchTable([t], { headerSignature: signature, columns: {}, descriptionContinuation: "none" })).toBeNull();
  });

  it("picks the better-scoring of two candidate tables", () => {
    // Missing "Gesamt" -> 4/5 = 0.8, still above threshold but not the best available.
    const worse = table(["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Sonstiges"], []);
    const better = table(signature, []);
    expect(matchTable([worse, better], { headerSignature: signature, columns: {}, descriptionContinuation: "none" })).toBe(
      better,
    );
  });

  it("keeps the first table on a score tie (strict '>' never re-picks an equal scorer)", () => {
    const first = table(signature, [["first"]]);
    const second = table(signature, [["second"]]);
    expect(matchTable([first, second], { headerSignature: signature, columns: {}, descriptionContinuation: "none" })).toBe(
      first,
    );
  });

  it("returns null for an empty tables array", () => {
    expect(matchTable([], { headerSignature: signature, columns: {}, descriptionContinuation: "none" })).toBeNull();
  });

  describe("INVEX-041 — asymmetric fuzzy match", () => {
    // The score only tests header.includes(signature), never the reverse. A short
    // signature cell like "ME" (Mengeneinheit, a common German unit-of-measure
    // column header) is therefore a substring of all kinds of unrelated headers —
    // here a "Nummer" column from a completely different table (customer number,
    // not a line-item table at all) — and wins outright at score 1.0.
    const decoy = table(["Nummer"], []);
    const descriptor: LineItemTableDescriptor = { headerSignature: ["ME"], columns: {}, descriptionContinuation: "none" };

    it("[current] a bare 'ME' signature matches an unrelated 'Nummer' header", () => {
      expect(matchTable([decoy], descriptor)).toBe(decoy);
    });

    knownBug("INVEX-041", "short signature cell substring-matches any unrelated header").it(
      "a bare 'ME' signature does not match an unrelated 'Nummer' header",
      () => {
        expect(matchTable([decoy], descriptor)).toBeNull();
      },
    );
  });
});

describe("applyTemplate / findField — anchoring", () => {
  it("resolves a region descriptor on the LAST page (page: -1) within REGION_INFLATE slack", () => {
    // The recorded region sits 0.01 above the line's bbox (0.19 vs the line's 0.20) —
    // only bridged because REGION_INFLATE (0.05) pads the region before intersecting.
    const grossLine = line("Gesamtbetrag: 1.366,95 EUR", { page: 2, x: 0.5, y: 0.2, width: 0.45, height: 0.02 });
    const d = doc([], { tables: [], pageCount: 2 });
    d.lines.push(grossLine);
    const template = baseTemplate({
      "totals.gross": { region: { page: -1, bbox: [0.5, 0.14, 0.95, 0.19] }, valuePattern: "[\\d.,]+,\\d{2}" },
    });
    const { envelope, fieldsHit } = applyTemplate(template, d);
    expect(fieldsHit).toContain("totals.gross");
    expect(envelope.invoice.totals?.gross).toBe("1366.95");
  });

  it("resolves a label-anchored descriptor with no region", () => {
    const d = doc([line("Rechnungsnummer: R-2026-0042", { x: 0.1, y: 0.1, width: 0.5 })]);
    const template = baseTemplate({ invoiceNumber: { label: "Rechnungsnummer" } });
    const { envelope, fieldsHit } = applyTemplate(template, d);
    expect(fieldsHit).toContain("invoiceNumber");
    expect(envelope.invoice.invoiceNumber).toBe("R-2026-0042");
  });

  it("rejects a value that fails valuePattern, leaving the field missed", () => {
    const d = doc([line("Rechnungsnummer: R-2026-0042", { x: 0.1, y: 0.1, width: 0.5 })]);
    const template = baseTemplate({ invoiceNumber: { label: "Rechnungsnummer", valuePattern: "^\\d+$" } });
    const { envelope, fieldsHit, fieldsMissed } = applyTemplate(template, d);
    expect(fieldsHit).not.toContain("invoiceNumber");
    expect(fieldsMissed).toContain("invoiceNumber");
    expect(envelope.invoice.invoiceNumber).toBeUndefined();
  });

  it("assigns a distinct confidence for every rung of the anchor ladder", () => {
    // Same line, same value — only the descriptor's anchor combination changes.
    // hasRegion && hadLabel && pattern=0.95, hasRegion && pattern=0.8,
    // hadLabel && pattern=0.75, hadLabel only=0.6, hasRegion only=0.5, neither=0.3.
    const bbox: [number, number, number, number] = [0.1, 0.1, 0.6, 0.12];
    const region = { page: 1, bbox };
    const pattern = "R-\\d+-\\d+";
    const withLine = (fields: VendorTemplate["fields"]) =>
      applyTemplate(baseTemplate(fields), doc([line("Rechnungsnummer: R-2026-0042", { x: 0.1, y: 0.1, width: 0.5 })]))
        .envelope.fieldMeta["invoiceNumber"]?.confidence;

    expect(withLine({ invoiceNumber: { region, label: "Rechnungsnummer", valuePattern: pattern } })).toBe(0.95);
    expect(withLine({ invoiceNumber: { region, valuePattern: pattern } })).toBe(0.8);
    expect(withLine({ invoiceNumber: { label: "Rechnungsnummer", valuePattern: pattern } })).toBe(0.75);
    expect(withLine({ invoiceNumber: { label: "Rechnungsnummer" } })).toBe(0.6);
    expect(withLine({ invoiceNumber: { region } })).toBe(0.5);
    expect(withLine({ invoiceNumber: {} })).toBe(0.3);
  });

  it("falls back to the line below when the value sits on its own line", () => {
    // Explicit x offsets (via columnLine) pin down the x-overlap band the fallback
    // relies on — a common layout for a "label:" line followed by its value line.
    const labelLine = columnLine([{ text: "Fälligkeitsdatum:", x: 0.1, width: 0.3 }], { y: 0.3 });
    const valueLine = columnLine([{ text: "01.09.2026", x: 0.1, width: 0.2 }], { y: 0.33 });
    const d: PositionedTextDocument = { pageCount: 1, lines: [labelLine, valueLine], tables: [] };
    const template = baseTemplate({ dueDate: { label: "Fälligkeitsdatum" } });
    const { envelope, fieldsHit } = applyTemplate(template, d);
    expect(fieldsHit).toContain("dueDate");
    expect(envelope.invoice.dueDate).toBe("2026-09-01");
  });

  it("reports fieldsHit / fieldsMissed for a mix of found and absent descriptors", () => {
    const d = doc([line("Rechnungsnummer: R-2026-0042", { x: 0.1, y: 0.1, width: 0.5 })]);
    const template = baseTemplate({
      invoiceNumber: { label: "Rechnungsnummer" },
      issueDate: { label: "Rechnungsdatum" }, // not present anywhere in the doc
    });
    const { fieldsHit, fieldsMissed } = applyTemplate(template, d);
    expect(fieldsHit).toEqual(["invoiceNumber"]);
    expect(fieldsMissed).toEqual(["issueDate"]);
  });

  it("misses every descriptor cleanly on an unrelated layout, without throwing", () => {
    const d = doc([line("Völlig anderes Layout", { x: 0.1, y: 0.1, width: 0.5 })]);
    const template = baseTemplate({
      invoiceNumber: { label: "Rechnungsnummer" },
      issueDate: { label: "Rechnungsdatum" },
    });
    let result;
    expect(() => (result = applyTemplate(template, d))).not.toThrow();
    expect(result!.fieldsHit).toHaveLength(0);
    expect(result!.fieldsMissed).toEqual(["invoiceNumber", "issueDate"]);
    expect(result!.envelope.invoice.invoiceNumber).toBeUndefined();
  });

  it("extracts line items via a matched lineItemTable", () => {
    const t = table(
      ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
      [["1", "Aktenvernichter", "2", "199,50", "399,00"]],
    );
    const d: PositionedTextDocument = { pageCount: 1, lines: [], tables: [t] };
    const template = baseTemplate(
      {},
      {
        headerSignature: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
        columns: { position: 0, description: 1, quantity: 2, unitPrice: 3, lineTotal: 4 },
        descriptionContinuation: "none",
      },
    );
    const { envelope, fieldsHit } = applyTemplate(template, d);
    expect(fieldsHit).toContain("lineItems");
    expect(envelope.invoice.lineItems).toHaveLength(1);
    expect(envelope.invoice.lineItems?.[0]).toMatchObject({
      description: "Aktenvernichter",
      quantity: "2",
      unitPrice: "199.50",
      lineTotal: "399.00",
    });
    expect(envelope.fieldMeta["lineItems.0"]).toMatchObject({ source: "template", confidence: 0.85 });
  });

  describe("INVEX-042 — label offset mismatch between normalized search and raw slice", () => {
    // The label is found in the NORMALIZED line text (any occurrence, position
    // discarded), but the remainder is sliced using approximateLabelEnd's own
    // independent search over the RAW text, which always anchors to the FIRST raw
    // occurrence. When a decoy label/value pair precedes the real one on the same
    // line — plausible after an OCR/reflow merge, e.g. a superseded invoice number
    // referenced before the current one — the decoy's value wins.
    const decoyThenReal = "Rechnungsnummer alt R-0000-0000 Rechnungsnummer R-2026-0042";
    const d = doc([line(decoyThenReal, { x: 0.05, y: 0.1, width: 0.9 })]);
    const template = baseTemplate({ invoiceNumber: { label: "Rechnungsnummer", valuePattern: "R-\\d+-\\d+" } });

    it("[current] extracts the decoy invoice number preceding the real one", () => {
      expect(applyTemplate(template, d).envelope.invoice.invoiceNumber).toBe("R-0000-0000");
    });

    knownBug("INVEX-042", "label offset anchors to the wrong occurrence, extracting a decoy value").it(
      "extracts the real (last-occurring) invoice number, not the decoy",
      () => {
        expect(applyTemplate(template, d).envelope.invoice.invoiceNumber).toBe("R-2026-0042");
      },
    );
  });

  describe("INVEX-043 — seller always overwritten from vendorIds", () => {
    // invoice.seller is set unconditionally from template.vendorIds, even when
    // every identifier field is absent/null. Downstream, that produces a seller
    // block with source "template" full confidence, masking whatever (if
    // anything) the extraction actually found for the seller.
    const d = doc([line("irrelevant", { x: 0.1, y: 0.1, width: 0.3 })]);
    const template = baseTemplate({}); // vendorIds: {} — no identifiers at all

    it("[current] always sets an all-null seller block", () => {
      expect(applyTemplate(template, d).envelope.invoice.seller).toEqual({
        name: null,
        ustIdNr: null,
        steuernummer: null,
        ibans: [],
      });
    });

    knownBug("INVEX-043", "seller always overwritten even when vendorIds carries no identifier").it(
      "leaves seller unset when vendorIds carries no identifier",
      () => {
        expect(applyTemplate(template, d).envelope.invoice.seller).toBeUndefined();
      },
    );
  });

  it("throws from inside applyTemplate on a malformed persisted valuePattern (unassigned defect, see report)", () => {
    // `new RegExp(d.valuePattern)` runs with no try/catch. A malformed regex
    // string reaching a persisted template (e.g. hand-edited, or a future bad
    // induction) crashes template application outright instead of missing the
    // field cleanly like every other unmatched descriptor.
    const d = doc([line("Rechnungsnummer: R-2026-0042", { x: 0.1, y: 0.1, width: 0.5 })]);
    const template = baseTemplate({ invoiceNumber: { label: "Rechnungsnummer", valuePattern: "(" } });
    expect(() => applyTemplate(template, d)).toThrow(/Invalid regular expression/);
  });
});

describe("applyTemplate — malformed valuePattern", () => {
  knownBug("INVEX-046", "valuePattern is compiled with no try/catch, so a bad persisted pattern throws")
    .it("misses cleanly instead of throwing on an uncompilable pattern", () => {
      // Templates are machine-induced today, but the briefing describes them as
      // human-editable, and they are persisted jsonb that outlives the code that
      // wrote them. Every other unmatched descriptor misses cleanly; this one
      // takes the whole stage down, which costs the document an attempt.
      const t: VendorTemplate = {
        templateVersion: 1,
        vendorIds: { displayName: "ACME", nameHash: "acme" },
        locale: { decimal: ",", dateFormats: ["dd.MM.yyyy"] },
        fields: { invoiceNumber: { label: "Rechnungsnummer", valuePattern: "(" } },
      };
      const d = doc([line("Rechnungsnummer R-2026-0042", { y: 0.1 })]);
      expect(() => applyTemplate(t, d)).not.toThrow();
    });
});
