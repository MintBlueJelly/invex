import { describe, expect, it } from "vitest";
import { classify, positionedToMarkdown, type ClassifierConfigCore, type PositionedTextDocument } from "../../../src/index";
import { knownBug } from "../../../../../test-utils/knownBug";
import { line, doc, table } from "../../utils/positionedBuilders";

/**
 * Shared calibration for the feature-isolation tests below. Weights are chosen
 * distinct (3,2,2,1,2,2) so that summed scores identify which features fired.
 */
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

describe("classify — F1 heading keyword", () => {
  // "Rechnung" alone (no trailing word chars) is the only text that clears the
  // \b(rechnung|...)​\b word-boundary regex; "Rechnungsdatum"/"Rechnungsnummer"
  // etc. do NOT match it, which is what keeps this feature isolated from F2/F4.
  it("fires for a heading-tagged line regardless of its y-position", () => {
    const d = doc([line("Rechnung", { tag: "section_header", y: 0.6 })]);
    expect(classify(d, config).features["F1_headingKeyword"]).toBe(1);
  });

  it("fires for an untagged line in the top-of-page-1 band (y < 0.25)", () => {
    const d = doc([line("Rechnung", { y: 0.2 })]);
    expect(classify(d, config).features["F1_headingKeyword"]).toBe(1);
  });

  it("does not fire for an untagged line below the top band", () => {
    const d = doc([line("Rechnung", { y: 0.5 })]);
    expect(classify(d, config).features["F1_headingKeyword"]).toBe(0);
  });

  it("treats y = 0.25 as already outside the top band (strict <)", () => {
    const d = doc([line("Rechnung", { y: 0.25 })]);
    expect(classify(d, config).features["F1_headingKeyword"]).toBe(0);
  });

  it("does not use the top-of-page band on page 2, even at y = 0.1", () => {
    const d = doc([line("Rechnung", { page: 2, y: 0.1 })]);
    expect(classify(d, config).features["F1_headingKeyword"]).toBe(0);
  });

  it("a heading tag still fires on page 2 (the tag path ignores page/position)", () => {
    const d = doc([line("Rechnung", { page: 2, y: 0.6, tag: "title" })]);
    expect(classify(d, config).features["F1_headingKeyword"]).toBe(1);
  });

  it("does not fire when the matched line is 60 chars or longer", () => {
    const long = `Rechnung ${"x".repeat(60)}`;
    const d = doc([line(long, { tag: "section_header" })]);
    expect(long.trim().length).toBeGreaterThanOrEqual(60);
    expect(classify(d, config).features["F1_headingKeyword"]).toBe(0);
  });
});

describe("classify — F2 invoice-number pattern", () => {
  it("fires when a number label sits next to a number-shaped value", () => {
    const d = doc([line("Rechnungs-Nr.: R-2026-0042")]);
    expect(classify(d, config).features["F2_invoiceNumberPattern"]).toBe(1);
  });

  it("does not fire when the label has no adjacent digits", () => {
    const d = doc([line("Rechnungsnummer: siehe Anhang")]);
    expect(classify(d, config).features["F2_invoiceNumberPattern"]).toBe(0);
  });
});

describe("classify — F3 tax-id present (DE-only)", () => {
  it("fires for a checksum-valid USt-IdNr", () => {
    const d = doc([line("USt-IdNr.: DE811907980")]);
    expect(classify(d, config).features["F3_taxIdPresent"]).toBe(1);
  });

  it("does not fire for a DE-shaped id that fails the MOD 11,10 checksum", () => {
    const d = doc([line("USt-IdNr.: DE123456789")]);
    expect(classify(d, config).features["F3_taxIdPresent"]).toBe(0);
  });

  it("fires for a labeled Steuernummer in Bundesland format (no checksum exists for it)", () => {
    const d = doc([line("Steuernummer: 12/1234/12345")]);
    expect(classify(d, config).features["F3_taxIdPresent"]).toBe(1);
  });
});

describe("classify — F4 labeled invoice date", () => {
  it("fires for a Rechnungsdatum label next to a parseable date", () => {
    const d = doc([line("Rechnungsdatum: 15.06.2026")]);
    expect(classify(d, config).features["F4_labeledInvoiceDate"]).toBe(1);
  });

  it("does not fire when the label has no date-shaped value at all", () => {
    const d = doc([line("Rechnungsdatum: siehe Anlage")]);
    expect(classify(d, config).features["F4_labeledInvoiceDate"]).toBe(0);
  });

  it("does not fire when the value matches the date pattern but isn't a real date", () => {
    // 31.13.2026: month 13 — matches \d..\d..\d but fails every format in
    // DEFAULT_DATE_FORMATS, so parseDateToIso returns null.
    const d = doc([line("Rechnungsdatum: 31.13.2026")]);
    expect(classify(d, config).features["F4_labeledInvoiceDate"]).toBe(0);
  });
});

describe("classify — F5 VAT breakdown block", () => {
  it("fires for a closed-set VAT percentage next to an amount", () => {
    const d = doc([line("MwSt. 19%: 218,25 EUR")]);
    expect(classify(d, config).features["F5_vatBreakdownBlock"]).toBe(1);
  });

  it("does not fire for a percentage outside the closed set {19, 7, 0}", () => {
    const d = doc([line("MwSt. 15%: 100,00 EUR")]);
    expect(classify(d, config).features["F5_vatBreakdownBlock"]).toBe(0);
  });
});

describe("classify — F6 currency amount table", () => {
  it("fires when a column is >=60% cells ending in [.,]\\d{2}", () => {
    const d = doc(["Bestellung"], {
      tables: [table(["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"], [["1", "Ware", "2", "199,50", "399,00"]])],
    });
    expect(classify(d, config).features["F6_currencyAmountTable"]).toBe(1);
  });

  it("does not fire for integer-looking cells with no 2-decimal tail (e.g. '19', '1.234')", () => {
    const d = doc(["Bestellung"], {
      tables: [table(["Pos", "Menge"], [["1", "19"], ["2", "1.234"]])],
    });
    expect(classify(d, config).features["F6_currencyAmountTable"]).toBe(0);
  });
});

describe("classify — score arithmetic", () => {
  it("sums to exactly the weighted features that fired (no others)", () => {
    // F3 (tax id) + F6 (currency table) only: 2 + 2 = 4.
    const d: PositionedTextDocument = {
      pageCount: 1,
      lines: [line("USt-IdNr.: DE811907980")],
      tables: [table(["Pos", "Betrag"], [["1", "199,50"]])],
    };
    const r = classify(d, config);
    expect(r.features).toEqual({
      F1_headingKeyword: 0,
      F2_invoiceNumberPattern: 0,
      F3_taxIdPresent: 1,
      F4_labeledInvoiceDate: 0,
      F5_vatBreakdownBlock: 0,
      F6_currencyAmountTable: 1,
    });
    expect(r.score).toBe(4);
    const recomputed = Object.entries(r.features).reduce(
      (sum, [name, on]) => sum + on * (config.weights[name] ?? 0),
      0,
    );
    expect(r.score).toBe(recomputed);
  });
});

describe("classify — band boundaries", () => {
  it("score exactly at invoiceMin (7) lands in the invoice band", () => {
    // F1 (3) + F2 (2) + F3 (2) = 7.
    const d = doc([
      line("Rechnung", { tag: "section_header" }),
      line("Rechnungs-Nr.: R-2026-0042"),
      line("USt-IdNr.: DE811907980"),
    ]);
    const r = classify(d, config);
    expect(r.score).toBe(7);
    expect(r.band).toBe("invoice");
  });

  it("one point below invoiceMin (6) lands in the uncertain band", () => {
    // F1 (3) + F2 (2) + F4 (1) = 6.
    const d = doc([
      line("Rechnung", { tag: "section_header" }),
      line("Rechnungs-Nr.: R-2026-0042"),
      line("Rechnungsdatum: 15.06.2026"),
    ]);
    const r = classify(d, config);
    expect(r.score).toBe(6);
    expect(r.band).toBe("uncertain");
  });

  it("score exactly at nonInvoiceMax (3) lands in the non_invoice band", () => {
    // F1 alone = 3.
    const d = doc([line("Rechnung", { tag: "section_header" })]);
    const r = classify(d, config);
    expect(r.score).toBe(3);
    expect(r.band).toBe("non_invoice");
  });

  it("one point above nonInvoiceMax (4) lands in the uncertain band", () => {
    // F1 (3) + F4 (1) = 4.
    const d = doc([line("Rechnung", { tag: "section_header" }), line("Rechnungsdatum: 15.06.2026")]);
    const r = classify(d, config);
    expect(r.score).toBe(4);
    expect(r.band).toBe("uncertain");
  });
});

describe("classify — end-to-end documents", () => {
  it("classifies a full German invoice as invoice", () => {
    const d: PositionedTextDocument = {
      pageCount: 1,
      lines: [
        line("Rechnung", { tag: "section_header" }),
        line("Rechnungs-Nr.: R-2026-0042"),
        line("Rechnungsdatum: 15.06.2026"),
        line("USt-IdNr.: DE811907980"),
        line("MwSt. 19%: 218,25 EUR"),
      ],
      tables: [table(["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"], [["1", "Ware", "2", "199,50", "399,00"]])],
    };
    const r = classify(d, config);
    expect(r.band).toBe("invoice");
  });

  it("classifies a plain business letter as non_invoice", () => {
    const d = doc([
      line("Sehr geehrte Damen und Herren,", { tag: "section_header" }),
      line("vielen Dank für Ihre Anfrage vom 3. Juni 2026."),
      line("Wir kommen gerne auf Sie zurück, sobald weitere Informationen vorliegen."),
    ]);
    const r = classify(d, config);
    expect(r.band).toBe("non_invoice");
    expect(r.score).toBe(0);
  });
});

describe("classify — known-bug pins", () => {
  it("[current] a mistyped weight key silently contributes zero to the score", () => {
    const badConfig: ClassifierConfigCore = {
      weights: {
        F1_headingKeyword: 3,
        F2_InvoiceNumberPattern: 2, // typo: capital "I" — does not match the real feature key
        F3_taxIdPresent: 2,
        F4_labeledInvoiceDate: 1,
        F5_vatBreakdownBlock: 2,
        F6_currencyAmountTable: 2,
      },
      bands: { invoiceMin: 7, nonInvoiceMax: 3 },
    };
    const d = doc([line("Rechnungs-Nr.: R-2026-0042")]);
    const r = classify(d, badConfig);
    expect(r.features["F2_invoiceNumberPattern"]).toBe(1); // the feature itself still fires
    expect(r.score).toBe(0); // but its weight silently never applied
  });

  knownBug(
    "INVEX-020",
    "an unknown/misspelled weight key silently contributes 0 instead of the classifier rejecting the config",
  ).it("rejects a config whose weight keys don't cover the feature set", () => {
    const badConfig: ClassifierConfigCore = {
      weights: { F1_headingKeyword: 3, F2_InvoiceNumberPattern: 2 },
      bands: { invoiceMin: 7, nonInvoiceMax: 3 },
    };
    const d = doc([line("Rechnungs-Nr.: R-2026-0042")]);
    expect(() => classify(d, badConfig)).toThrow();
  });

  it("[current] invoiceMin <= nonInvoiceMax lets the invoice branch win first", () => {
    const invertedBands: ClassifierConfigCore = {
      weights: config.weights,
      bands: { invoiceMin: 2, nonInvoiceMax: 5 },
    };
    const d = doc([line("Rechnung", { tag: "section_header" })]); // score 3: intended to be "uncertain"/non-invoice territory
    const r = classify(d, invertedBands);
    expect(r.score).toBe(3);
    expect(r.band).toBe("invoice"); // the uncertain band has effectively vanished
  });

  knownBug("INVEX-021", "band thresholds are not validated; invoiceMin <= nonInvoiceMax erases the uncertain band").it(
    "rejects a band config where invoiceMin <= nonInvoiceMax",
    () => {
      const invertedBands: ClassifierConfigCore = {
        weights: config.weights,
        bands: { invoiceMin: 2, nonInvoiceMax: 5 },
      };
      const d = doc([line("Rechnung", { tag: "section_header" })]);
      expect(() => classify(d, invertedBands)).toThrow();
    },
  );
});

describe("positionedToMarkdown", () => {
  it("renders section_header/title lines as ## headings and leaves body text plain", () => {
    const d = doc([
      line("Rechnung", { tag: "section_header" }),
      line("Vielen Dank für Ihren Auftrag."),
      line("ANGABEN", { tag: "title" }),
    ]);
    expect(positionedToMarkdown(d)).toBe("## Rechnung\nVielen Dank für Ihren Auftrag.\n## ANGABEN");
  });

  it("inserts a --- separator when the page counter advances past 1", () => {
    const d: PositionedTextDocument = {
      pageCount: 2,
      lines: [line("Erste Seite", { page: 1 }), line("Zweite Seite", { page: 2 })],
      tables: [],
    };
    expect(positionedToMarkdown(d)).toBe("Erste Seite\n\n---\n\nZweite Seite");
  });

  it("still emits a leading --- separator when the FIRST line is already on page 2", () => {
    // The page tracker starts at 0, so the very first transition (0 -> 2) already
    // satisfies `page > 1` — a document sliced to start mid-way gets an orphan
    // separator before any content.
    const d: PositionedTextDocument = { pageCount: 2, lines: [line("Nur Seite 2", { page: 2 })], tables: [] };
    expect(positionedToMarkdown(d)).toBe("\n---\n\nNur Seite 2");
  });

  it("renders a table as a Markdown pipe table with a --- header separator row", () => {
    const d = doc(["Intro text"], { tables: [table(["A", "B"], [["1", "2"], ["3", "4"]])] });
    expect(positionedToMarkdown(d)).toBe("Intro text\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
  });

  it("renders an empty document as an empty string", () => {
    const d: PositionedTextDocument = { pageCount: 1, lines: [], tables: [] };
    expect(positionedToMarkdown(d)).toBe("");
  });

  describe("known-bug pins", () => {
    it("[current] a page-1 table is still appended after page-2 prose (tables always trail all text)", () => {
      const d: PositionedTextDocument = {
        pageCount: 2,
        lines: [
          line("Bestellübersicht", { tag: "section_header" }),
          line("Zahlungshinweise auf Seite 2.", { page: 2 }),
        ],
        tables: [table(["Pos", "Betrag"], [["1", "10,00"]], { page: 1 })],
      };
      const md = positionedToMarkdown(d);
      const tableIdx = md.indexOf("| Pos | Betrag |");
      const page2Idx = md.indexOf("Zahlungshinweise");
      expect(tableIdx).toBeGreaterThan(page2Idx);
    });

    knownBug(
      "INVEX-022",
      "positionedToMarkdown appends all tables after all text regardless of page/position, detaching a table from the prose introducing it",
    ).it("keeps a page-1 table before page-2 prose in the rendered output", () => {
      const d: PositionedTextDocument = {
        pageCount: 2,
        lines: [
          line("Bestellübersicht", { tag: "section_header" }),
          line("Zahlungshinweise auf Seite 2.", { page: 2 }),
        ],
        tables: [table(["Pos", "Betrag"], [["1", "10,00"]], { page: 1 })],
      };
      const md = positionedToMarkdown(d);
      const tableIdx = md.indexOf("| Pos | Betrag |");
      const page2Idx = md.indexOf("Zahlungshinweise");
      expect(tableIdx).toBeLessThan(page2Idx);
    });

    it("[current] a pipe inside a cell is emitted unescaped, corrupting the table's column count", () => {
      const d = doc(["Intro"], { tables: [table(["Beschreibung", "Betrag"], [["Kabel | 2m", "10,00"]])] });
      expect(positionedToMarkdown(d)).toContain("| Kabel | 2m | 10,00 |");
    });

    knownBug(
      "INVEX-022",
      "cell contents containing | are not escaped, corrupting the emitted Markdown table structure",
    ).it("escapes a pipe inside a cell so the column count is preserved", () => {
      const d = doc(["Intro"], { tables: [table(["Beschreibung", "Betrag"], [["Kabel | 2m", "10,00"]])] });
      expect(positionedToMarkdown(d)).toContain("| Kabel \\| 2m | 10,00 |");
    });
  });
});
