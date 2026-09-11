import { describe, expect, it } from "vitest";
import { detectKind } from "../../../src/classify/kind";
import { columnLine, doc, line } from "../../utils/positionedBuilders";

/** A heading in title position — the strongest kind evidence. */
const heading = (text: string) => doc([line(text, { y: 0.08, tag: "title" })]);

describe("detectKind — the five document classes", () => {
  it.each([
    ["Rechnung", "invoice"],
    ["Schlussrechnung", "invoice"],
    ["Abschlagsrechnung", "invoice"],
    ["Teilrechnung", "invoice"],
    ["Anzahlungsrechnung", "invoice"],
    ["Proformarechnung", "invoice"],
    ["Invoice", "invoice"],
    ["Gutschrift", "creditNote"],
    ["Gutschriftanzeige", "creditNote"],
    ["Stornorechnung", "creditNote"],
    ["Stornobeleg", "creditNote"],
    ["Credit Note", "creditNote"],
    ["Auftragsbestätigung", "orderConfirmation"],
    ["Bestellbestätigung", "orderConfirmation"],
    ["Auftragsannahme", "orderConfirmation"],
    ["Order Confirmation", "orderConfirmation"],
    ["Angebot", "quote"],
    ["Kostenvoranschlag", "quote"],
    ["Kostenschätzung", "quote"],
    ["Offerte", "quote"],
    ["Quotation", "quote"],
    ["Lieferschein", "deliveryNote"],
    ["Warenbegleitschein", "deliveryNote"],
    ["Packliste", "deliveryNote"],
    ["Delivery Note", "deliveryNote"],
  ])("classifies the heading %j as %s", (text, expected) => {
    expect(detectKind(heading(text)).kind).toBe(expected);
  });

  it("matches the ASCII transliteration of an umlaut heading", () => {
    expect(detectKind(heading("Auftragsbestaetigung")).kind).toBe("orderConfirmation");
  });

  it("is case-insensitive", () => {
    expect(detectKind(heading("AUFTRAGSBESTÄTIGUNG")).kind).toBe("orderConfirmation");
    expect(detectKind(heading("lieferschein")).kind).toBe("deliveryNote");
  });

  it("reports the matched term and the verbatim line", () => {
    const r = detectKind(heading("Auftragsbestätigung Nr. AB-2026-0042"));
    expect(r.kind).toBe("orderConfirmation");
    expect(r.matchedTerm).toBe("auftragsbestatigung");
    expect(r.rawLine).toBe("Auftragsbestätigung Nr. AB-2026-0042");
    expect(r.anchor?.page).toBe(1);
    expect(r.anchor?.bbox[1]).toBeCloseTo(0.08, 10);
  });
});

describe("detectKind — precedence", () => {
  // The concrete reason PRECEDENCE exists: the bare "Rechnung" later in the
  // line DOES satisfy /\brechnung\b/, so without ranking this commits as an
  // invoice.
  it("ranks a correction above the invoice it corrects", () => {
    const r = detectKind(heading("Rechnungskorrektur zu Rechnung R-2026-0042"));
    expect(r.kind).toBe("creditNote");
    expect(r.competing).toEqual(["invoice", "creditNote"]);
  });

  it("ranks Gutschrift above a referenced Rechnung", () => {
    expect(detectKind(heading("Gutschrift zur Rechnung 123")).kind).toBe("creditNote");
  });

  it("ranks a hyphenated Storno-Rechnung as a credit note", () => {
    expect(detectKind(heading("Storno-Rechnung")).kind).toBe("creditNote");
  });

  it("prefers a title over a section_header", () => {
    const d = doc([
      line("Lieferschein", { y: 0.05, tag: "section_header" }),
      line("Rechnung", { y: 0.12, tag: "title" }),
    ]);
    expect(detectKind(d).kind).toBe("invoice");
  });

  it("prefers the higher line within one tag tier", () => {
    const d = doc([
      line("Rechnung", { y: 0.06, tag: "title" }),
      line("Lieferschein", { y: 0.18, tag: "title" }),
    ]);
    expect(detectKind(d).kind).toBe("invoice");
  });

  it("refuses to guess when two equally ranked headings disagree", () => {
    const d = doc([
      line("Rechnung", { y: 0.1, tag: "title" }),
      line("Lieferschein", { y: 0.1, tag: "title" }),
    ]);
    const r = detectKind(d);
    expect(r.kind).toBeNull();
    expect(r.competing).toEqual(["invoice", "deliveryNote"]);
  });
});

describe("detectKind — position and negatives", () => {
  it("ignores a class word outside heading position", () => {
    const d = doc([line("Lieferschein-Nr. 4711 vom 02.09.2026", { y: 0.62 })]);
    expect(detectKind(d).kind).toBeNull();
  });

  it("accepts an untagged line in the page-1 top band", () => {
    const d = doc([line("Angebot", { y: 0.2 })]);
    expect(detectKind(d).kind).toBe("quote");
  });

  it("rejects an untagged line below the top band", () => {
    const d = doc([line("Angebot", { y: 0.25 })]);
    expect(detectKind(d).kind).toBeNull();
  });

  it("ignores the top band on later pages", () => {
    const d = doc([line("Gutschrift", { y: 0.05, page: 2 })], { pageCount: 2 });
    expect(detectKind(d).kind).toBeNull();
  });

  // The <60-char cap earns its keep on the new classes specifically.
  it("ignores a body sentence that merely contains a class word", () => {
    const d = doc([
      line("Wir bestätigen Ihnen den Auftrag wie folgt und liefern in der 34. Kalenderwoche", {
        y: 0.1,
      }),
    ]);
    expect(detectKind(d).kind).toBeNull();
  });

  it("does not fire on a label rather than a heading", () => {
    expect(detectKind(heading("Rechnungsdatum")).kind).toBeNull();
    expect(detectKind(heading("Rechnungsnummer")).kind).toBeNull();
  });

  it("does not read a bare AB as an order confirmation", () => {
    expect(detectKind(heading("Lieferung ab 01.01.2026 ab Werk")).kind).toBeNull();
  });

  /**
   * INVEX-059 — on a German letterhead the title sits on the same text row as
   * the Absenderzeile, the small-print sender line above the address window.
   * mergeLines clusters at yTolerance 0.008, so Path C hands the gate one fused
   * line well over the 60-char cap and the document loses its only heading.
   */
  it("finds a title fused with the letterhead line on the same row", () => {
    const fused = columnLine(
      [
        {
          text: "Kartonwerk Ammertal GmbH + Co. KG | Talstraße 7 | 85276 Pfaffenhofen",
          x: 0.08,
          width: 0.4,
        },
        { text: "Auftragsbestätigung", x: 0.59, width: 0.2 },
      ],
      { y: 0.17 },
    );
    expect(fused.text.trim().length).toBeGreaterThan(60);

    const evidence = detectKind(doc([fused]));
    expect(evidence.kind).toBe("orderConfirmation");
    // The anchor is the RUN's box, not the line's: the fused line spans the
    // page and would point a template at the letterhead.
    expect(evidence.anchor).toEqual({ page: 1, bbox: [0.59, 0.17, 0.79, 0.19] });
  });

  it("still ignores a long body sentence, which stays one run however it is split", () => {
    // The cap's original job. Word gaps are far under RUN_GAP, so a sentence is
    // a single run and stays over the cap.
    const d = doc([
      line("Wir bestätigen Ihnen hiermit den Auftrag wie folgt und liefern in der 34. Kalenderwoche", {
        y: 0.1,
      }),
    ]);
    expect(detectKind(d).kind).toBeNull();
  });

  it("refuses to guess when two runs of one row name different classes", () => {
    // Splitting a row into runs must not turn a same-row disagreement into a
    // left-to-right coin toss: both ranking keys stay on the line, so the two
    // runs remain exactly tied and reach the ambiguity check.
    const fused = columnLine(
      [
        { text: "Lieferschein", x: 0.08, width: 0.2 },
        { text: "Rechnung", x: 0.6, width: 0.2 },
      ],
      { y: 0.12 },
    );
    const evidence = detectKind(doc([fused]));
    expect(evidence.kind).toBeNull();
    expect(evidence.competing).toEqual(["invoice", "deliveryNote"]);
  });

  it("returns no evidence for an ordinary business letter", () => {
    const d = doc([
      line("Informationen zu Ihrem Wartungsvertrag", { y: 0.08, tag: "title" }),
      line("Sehr geehrte Damen und Herren,", { y: 0.2 }),
    ]);
    expect(detectKind(d)).toEqual({
      kind: null,
      matchedTerm: null,
      rawLine: null,
      anchor: null,
      competing: [],
    });
  });
});
