import { describe, expect, it } from "vitest";
import {
  classify,
  runTextGate,
  segmentPages,
  slicePages,
  type ClassifierConfigCore,
  type PositionedLine,
  type PositionedTextDocument,
  type TextGateOptions,
} from "../../src/index";

function line(
  text: string,
  page = 1,
  bbox: [number, number, number, number] = [0.1, 0.1, 0.6, 0.12],
  tag?: string,
): PositionedLine {
  return { text, page, bbox, tokens: [{ text, page, bbox }], ...(tag ? { tag } : {}) };
}

function doc(lines: PositionedLine[], pageCount = 1): PositionedTextDocument {
  return { pageCount, lines, tables: [] };
}

const gateOpts: TextGateOptions = {
  minDictHitRate: 0.55,
  maxReplacementCharRatio: 0.05,
  maxSingleCharTokenRatio: 0.4,
  minTokensForVerdict: 10,
};

describe("text-quality gate", () => {
  it("passes real German invoice prose", () => {
    const d = doc([
      line("Rechnung über Lieferungen und Leistungen gemäß Vertrag"),
      line("Zahlbar innerhalb von dreißig Tagen ohne Abzug auf das folgende Konto"),
      line("Gesamtbetrag einschließlich Mehrwertsteuer und Versandkosten"),
      line("Bezeichnung Menge Einzelpreis Gesamtbetrag Zwischensumme"),
    ]);
    const r = runTextGate(d, gateOpts);
    expect(r.verdict).toBe("ok");
    expect(r.dictHitRate).toBeGreaterThan(0.7);
  });

  it("flags cid-token garbage regardless of dictionary score", () => {
    const r = runTextGate(doc([line("(cid:12) (cid:34) (cid:56)")]), gateOpts);
    expect(r.verdict).toBe("garbage");
    expect(r.cidTokens).toBe(3);
  });

  it("flags consonant-soup OCR junk via dictionary hit rate", () => {
    const junk = Array.from({ length: 6 }, () => line("qzwx vbnk jhgf pqzt wxcv bnmk lkjh gfds")).flat();
    const r = runTextGate(doc(junk), gateOpts);
    expect(r.verdict).toBe("garbage");
    expect(r.dictHitRate).toBeLessThan(0.1);
  });
});

describe("page segmentation", () => {
  it("keeps a normal document as one segment", () => {
    const segments = segmentPages(doc([line("Rechnung"), line("Gesamtbetrag: 119,00", 1)], 1));
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("invoice-candidate");
  });

  it("splits on a page-counter restart after a total block", () => {
    const d = doc(
      [
        line("Rechnung", 1, [0.6, 0.05, 0.8, 0.08], "section_header"),
        line("Seite 1 von 1", 1, [0.1, 0.95, 0.3, 0.97]),
        line("Gesamtbetrag: 119,00 EUR", 1, [0.5, 0.7, 0.9, 0.72]),
        line("Rechnung", 2, [0.6, 0.05, 0.8, 0.08], "section_header"),
        line("Seite 1 von 1", 2, [0.1, 0.95, 0.3, 0.97]),
        line("Gesamtbetrag: 50,00 EUR", 2, [0.5, 0.7, 0.9, 0.72]),
      ],
      2,
    );
    const segments = segmentPages(d);
    expect(segments.map((s) => s.pages)).toEqual([[1], [2]]);
  });

  it("tags trailing terms pages as attachment and slices them away", () => {
    const d = doc(
      [
        line("Rechnung", 1, [0.6, 0.05, 0.8, 0.08], "section_header"),
        line("Gesamtbetrag: 119,00 EUR", 1, [0.5, 0.7, 0.9, 0.72]),
        line("Allgemeine Geschäftsbedingungen", 2, [0.1, 0.06, 0.6, 0.09], "section_header"),
        line("Es gilt deutsches Recht.", 2, [0.1, 0.12, 0.5, 0.14]),
      ],
      2,
    );
    const segments = segmentPages(d);
    expect(segments).toEqual([
      { pages: [1], kind: "invoice-candidate" },
      { pages: [2], kind: "attachment" },
    ]);
    const sliced = slicePages(d, segments[0]!.pages);
    expect(sliced.pageCount).toBe(1);
    expect(sliced.lines.every((l) => l.page === 1)).toBe(true);
  });
});

describe("classifier bands", () => {
  const config: ClassifierConfigCore = {
    weights: {
      F1_headingKeyword: 3,
      F2_invoiceNumberPattern: 2,
      F3_taxIdPresent: 2,
      F4_labeledInvoiceDate: 1,
      F5_vatBreakdownBlock: 2,
      F6_currencyAmountTable: 2,
    },
    bands: { invoiceMin: 7, nonInvoiceMax: 3 },
  };

  it("scores a full-signal invoice into the invoice band", () => {
    const d: PositionedTextDocument = {
      pageCount: 1,
      lines: [
        line("Rechnung", 1, [0.6, 0.05, 0.8, 0.08], "section_header"),
        line("Rechnungs-Nr.: R-2026-0042"),
        line("Rechnungsdatum: 15.06.2026"),
        line("USt-IdNr.: DE811907980"),
        line("MwSt. 19%: 218,25 EUR"),
      ],
      tables: [
        {
          page: 1,
          bbox: [0.1, 0.3, 0.9, 0.6],
          headerCells: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
          rows: [["1", "Ware", "2", "199,50", "399,00"]],
        },
      ],
    };
    const r = classify(d, config);
    expect(r.band).toBe("invoice");
    expect(r.score).toBe(12);
    expect(r.features["F1_headingKeyword"]).toBe(1);
  });

  it("scores a letter into the non-invoice band", () => {
    const r = classify(
      doc([
        line("Allgemeine Geschäftsbedingungen", 1, [0.1, 0.06, 0.6, 0.09], "section_header"),
        line("Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts."),
      ]),
      config,
    );
    expect(r.band).toBe("non_invoice");
    expect(r.score).toBe(0);
  });

  it("lands partial signals in the uncertain band", () => {
    const r = classify(
      doc([
        line("Rechnung", 1, [0.6, 0.05, 0.8, 0.08], "section_header"),
        line("USt-IdNr.: DE811907980"),
      ]),
      config,
    );
    expect(r.band).toBe("uncertain");
    expect(r.score).toBe(5);
  });
});
