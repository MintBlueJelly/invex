import { describe, expect, it } from "vitest";
import { knownBug } from "../../../../../test-utils/knownBug";
import { runRuleEngine } from "../../../src/index";
import { doc, line, table } from "../../utils/positionedBuilders";

/**
 * The generic rule engine — the lane EVERY first-seen vendor takes, and which
 * had zero tests. Phase 1 fills this out; what is here now is the pair that
 * validates the known-bug machinery end to end.
 */

describe("runRuleEngine — invoice number", () => {
  it("reads a properly labelled invoice number", () => {
    const d = doc([line("Rechnungsnummer R-2026-0042", { y: 0.1 })]);
    expect(runRuleEngine(d).envelope.invoice.invoiceNumber).toBe("R-2026-0042");
  });

  it("[current] a bare 'Rechnung' label captures the date as the invoice number", () => {
    // Records today's behaviour so a refactor to a THIRD wrong answer is caught
    // even while the pin below still "passes". See lexicon.ts:31 — bare
    // "Rechnung" is an invoiceNumber label, and the valuePattern accepts dots.
    const d = doc([line("Rechnung 12.06.2026", { y: 0.1 })]);
    expect(runRuleEngine(d).envelope.invoice.invoiceNumber).toBe("12.06.2026");
  });

  knownBug("INVEX-012", "bare 'Rechnung' is an invoiceNumber label and the pattern accepts dots")
    .it("does not mistake a date for an invoice number", () => {
      const d = doc([line("Rechnung 12.06.2026", { y: 0.1 })]);
      expect(runRuleEngine(d).envelope.invoice.invoiceNumber).not.toBe("12.06.2026");
    });
});

describe("runRuleEngine — header field extraction", () => {
  it("reads all six header fields from realistic German labels", () => {
    const d = doc([
      line("Rechnungsnummer RE-2026-001", { y: 0.05 }),
      line("Rechnungsdatum 01.03.2026", { y: 0.08 }),
      line("Fällig am 15.03.2026", { y: 0.11 }),
      line("Nettobetrag 1.000,00", { y: 0.14 }),
      line("MwSt 190,00", { y: 0.17 }),
      line("Gesamtbetrag 1.190,00", { y: 0.2 }),
    ]);
    const { envelope, fieldsFound, fieldsMissed } = runRuleEngine(d);
    expect(envelope.invoice).toMatchObject({
      invoiceNumber: "RE-2026-001",
      issueDate: "2026-03-01",
      dueDate: "2026-03-15",
      totals: { net: "1000.00", tax: "190.00", gross: "1190.00" },
    });
    // Order follows lexicon.header's own key order — a stable, meaningful signal
    // (it is the order fields would be logged/escalated in, per briefing §8).
    expect(fieldsFound).toEqual(["invoiceNumber", "issueDate", "dueDate", "totals.net", "totals.tax", "totals.gross"]);
    expect(fieldsMissed).toEqual(["lineItems"]);
  });

  it("records provenance for a header field, not just its value", () => {
    const d = doc([line("Rechnungsnummer RE-2026-001", { y: 0.1 })]);
    const meta = runRuleEngine(d).envelope.fieldMeta["invoiceNumber"];
    expect(meta).toMatchObject({ source: "rules", confidence: 0.65, rawText: "RE-2026-001" });
    expect(meta?.anchor?.page).toBe(1);
  });

  it("records the pre-parse raw text for an amount field, not the normalized value", () => {
    // rawText carries "190,00" (as printed), not the dot-decimal "190.00" the
    // canonical schema uses — reviewers need to see what the document actually said.
    const d = doc([line("MwSt 190,00", { y: 0.1 })]);
    const meta = runRuleEngine(d).envelope.fieldMeta["totals.tax"];
    expect(meta?.rawText).toBe("190,00");
  });
});

describe("runRuleEngine — label matching is startsWith-anchored", () => {
  it("ignores a label that appears mid-line rather than at the line's start", () => {
    // "Ihre Rechnungsnummer: RE-001" holds a perfectly good invoice number, but
    // findLabelHits requires the LINE itself (not a substring of it) to start
    // with the label.
    const d = doc([line("Ihre Rechnungsnummer: RE-001", { y: 0.1 })]);
    const { envelope, fieldsMissed } = runRuleEngine(d);
    expect(envelope.invoice.invoiceNumber).toBeUndefined();
    expect(fieldsMissed).toContain("invoiceNumber");
  });

  it("the longest matching label wins even when a shorter label's line comes first in the document", () => {
    // "Mehrwertsteuer" (14 normalized chars) sorts ahead of "USt" (3), so its
    // line is tried first and wins outright — the earlier USt line is never
    // even considered once a longer-label hit succeeds.
    const d = doc([line("USt 50,00", { y: 0.1 }), line("Mehrwertsteuer 190,00", { y: 0.13 })]);
    expect(runRuleEngine(d).envelope.invoice.totals?.tax).toBe("190.00");
  });

  it("a hit with no parseable value falls through to the next label instead of giving up", () => {
    // "USt-IdNr." starts with the "USt" tax label, but its remainder ("-IdNr.
    // DE123456789") does not lead with a number, so extractAmountValue declines
    // it. No other tax line exists here, so the field is correctly left missing
    // rather than reading a VAT ID as an amount.
    const d = doc([line("USt-IdNr. DE123456789", { y: 0.1 })]);
    const { envelope, fieldsMissed } = runRuleEngine(d);
    expect(envelope.invoice.totals?.tax).toBeUndefined();
    expect(fieldsMissed).toContain("totals.tax");
  });
});

describe("runRuleEngine — valuePattern enforcement", () => {
  it("declines an invoice number label whose remainder has no digit", () => {
    const d = doc([line("Rechnungsnummer ABCDEF", { y: 0.1 })]);
    const { envelope, fieldsMissed } = runRuleEngine(d);
    expect(envelope.invoice.invoiceNumber).toBeUndefined();
    expect(fieldsMissed).toContain("invoiceNumber");
  });

  it("declines a due date whose digits match the DATE shape but aren't a real calendar date", () => {
    // The DATE regex is shape-only; parseDateToIso is what actually rejects
    // "99.99.9999" (month 99), so the field must end up missing, not garbage.
    const d = doc([line("Fällig am 99.99.9999", { y: 0.1 })]);
    const { envelope, fieldsMissed } = runRuleEngine(d);
    expect(envelope.invoice.dueDate).toBeUndefined();
    expect(fieldsMissed).toContain("dueDate");
  });

  it("extracts an amount whose remainder leads with a currency symbol", () => {
    const d = doc([line("Gesamtbetrag: € 1.190,00", { y: 0.1 })]);
    expect(runRuleEngine(d).envelope.invoice.totals?.gross).toBe("1190.00");
  });
});

describe("runRuleEngine — VAT breakdown line scanner", () => {
  it("reads a single VAT rate line", () => {
    const d = doc([line("MwSt. 19%: 218,25", { y: 0.1 })]);
    const { envelope } = runRuleEngine(d);
    expect(envelope.invoice.vatBreakdown).toEqual([{ rate: 19, tax: "218.25", net: null }]);
    // No anchor/rawText here (unlike header fields) — the VAT scanner never
    // records which line it came from.
    expect(envelope.fieldMeta["vatBreakdown.0"]).toEqual({ source: "rules", confidence: 0.6 });
  });

  it("treats a spaced '19 %' the same as a tight '19%'", () => {
    const spaced = runRuleEngine(doc([line("MwSt 19 % : 218,25", { y: 0.1 })]));
    const tight = runRuleEngine(doc([line("MwSt 19%: 218,25", { y: 0.1 })]));
    expect(spaced.envelope.invoice.vatBreakdown).toEqual(tight.envelope.invoice.vatBreakdown);
  });

  it("collects multiple distinct VAT rates from separate lines", () => {
    const d = doc([line("MwSt 19% 100,00", { y: 0.1 }), line("MwSt 7% 20,00", { y: 0.13 })]);
    expect(runRuleEngine(d).envelope.invoice.vatBreakdown).toEqual([
      { rate: 19, tax: "100.00", net: null },
      { rate: 7, tax: "20.00", net: null },
    ]);
  });
});

describe("runRuleEngine — currency detection", () => {
  it.each([
    ["Betrag 10,00 €", "EUR"],
    ["Betrag 10.00 EUR", "EUR"],
    ["Amount $10.00", "USD"],
    ["Amount 10.00 GBP", "GBP"],
    ["no currency mentioned anywhere in this line", undefined],
  ])("detects %s as %s", (text, expected) => {
    const d = doc([line(text, { y: 0.1 })]);
    expect(runRuleEngine(d).envelope.invoice.currency).toBe(expected);
  });

  it("prefers EUR when a single line mentions both a EUR and a USD marker", () => {
    // Currency detection is a fixed if/else-if chain checked in EUR, USD, GBP
    // order — relevant for a converted quote or multi-currency footer line.
    const d = doc([line("10 EUR and $5", { y: 0.1 })]);
    expect(runRuleEngine(d).envelope.invoice.currency).toBe("EUR");
  });
});

describe("runRuleEngine — table column classification", () => {
  it("classifies a realistic German header row and extracts the line item", () => {
    const t = table(
      ["Pos", "Bezeichnung", "Menge", "Einheit", "Einzelpreis", "MwSt", "Gesamt"],
      [["1", "Beratung", "2", "Std", "100,00", "19%", "200,00"]],
    );
    const d = doc([], { tables: [t] });
    const { envelope, fieldsFound } = runRuleEngine(d);
    expect(envelope.invoice.lineItems).toEqual([
      {
        position: 1,
        description: "Beratung",
        quantity: "2",
        unit: "Std",
        unitPrice: "100.00",
        taxRate: 19,
        lineTotal: "200.00",
      },
    ]);
    expect(fieldsFound).toContain("lineItems");
    expect(envelope.fieldMeta["lineItems.0"]).toEqual({ source: "rules", confidence: 0.6 });
  });

  it("misses line items when no table has a recognizable description + amount column", () => {
    const t = table(["Foo", "Bar"], [["a", "b"]]);
    const d = doc([], { tables: [t] });
    const { envelope, fieldsMissed } = runRuleEngine(d);
    expect(envelope.invoice.lineItems).toBeUndefined();
    expect(fieldsMissed).toContain("lineItems");
  });
});

describe("runRuleEngine — empty and prose documents", () => {
  it("finds nothing in a document with no lines and no tables", () => {
    const d = doc([]);
    const { envelope, fieldsFound, fieldsMissed } = runRuleEngine(d);
    expect(envelope.invoice).toEqual({});
    expect(envelope.fieldMeta).toEqual({});
    expect(fieldsFound).toEqual([]);
    expect(fieldsMissed).toEqual([
      "invoiceNumber",
      "issueDate",
      "dueDate",
      "totals.net",
      "totals.tax",
      "totals.gross",
      "lineItems",
    ]);
  });

  it("finds nothing in a document of pure prose with no label anchors", () => {
    const d = doc([
      line("Just some prose about nothing in particular.", { y: 0.1 }),
      line("More text here too.", { y: 0.13 }),
    ]);
    const { envelope, fieldsMissed } = runRuleEngine(d);
    expect(envelope.invoice).toEqual({});
    expect(fieldsMissed).toContain("invoiceNumber");
    expect(envelope.invoice.currency).toBeUndefined();
  });
});

describe("runRuleEngine — known bugs", () => {
  it("[current] extractAmountValue takes the LAST number on a totals.net line, not the labelled one", () => {
    // Records today's (wrong) behaviour: "19" is the VAT rate trailing the
    // line, not the net amount right after the label.
    const d = doc([line("Nettobetrag 1.148,70 zzgl. 19% MwSt", { y: 0.1 })]);
    expect(runRuleEngine(d).envelope.invoice.totals?.net).toBe("19");
  });

  knownBug("INVEX-017", "extractAmountValue takes the last number on the line, not the labelled one")
    .it("reads the net amount that follows the label, not a trailing VAT rate", () => {
      const d = doc([line("Nettobetrag 1.148,70 zzgl. 19% MwSt", { y: 0.1 })]);
      expect(runRuleEngine(d).envelope.invoice.totals?.net).toBe("1148.70");
    });

  it("[current] 'Satz' under table.unitPrice claims the 'Steuersatz' (tax rate) column", () => {
    const t = table(
      ["Pos", "Artikel", "Anzahl", "Steuersatz", "Preis", "Betrag"],
      [["1", "Widget", "2", "19%", "10,00", "20,00"]],
    );
    const d = doc([], { tables: [t] });
    const items = runRuleEngine(d).envelope.invoice.lineItems;
    expect(items?.[0]).toMatchObject({ unitPrice: "19", taxRate: null });
  });

  knownBug("INVEX-018", "'Satz' under table.unitPrice substring-matches 'Steuersatz', stealing the tax-rate column")
    .it("classifies 'Preis' as unitPrice and 'Steuersatz' as taxRate, not the reverse", () => {
      const t = table(
        ["Pos", "Artikel", "Anzahl", "Steuersatz", "Preis", "Betrag"],
        [["1", "Widget", "2", "19%", "10,00", "20,00"]],
      );
      const d = doc([], { tables: [t] });
      const items = runRuleEngine(d).envelope.invoice.lineItems;
      expect(items?.[0]).toMatchObject({ unitPrice: "10.00", taxRate: 19 });
    });

  it("[current] an earlier integer-rate VAT line poisons a later fractional-rate line, which is dropped entirely", () => {
    const d = doc([line("MwSt 19 % 0,00", { y: 0.1 }), line("MwSt 2,5 % 14,00", { y: 0.13 })]);
    expect(runRuleEngine(d).envelope.invoice.vatBreakdown).toEqual([{ rate: 19, tax: "0.00", net: null }]);
  });

  knownBug("INVEX-019", "VAT rate regex caps at 2 digits and keeps only the first match, dropping fractional CH rates")
    .it("also captures the fractional 2.5% VAT line (Swiss rate)", () => {
      const d = doc([line("MwSt 19 % 0,00", { y: 0.1 }), line("MwSt 2,5 % 14,00", { y: 0.13 })]);
      const breakdown = runRuleEngine(d).envelope.invoice.vatBreakdown;
      expect(breakdown).toContainEqual({ rate: 2.5, tax: "14.00", net: null });
    });
});

describe("runRuleEngine — parenthesised label qualifiers", () => {
  it("[current] a label followed by a parenthesised qualifier extracts nothing", () => {
    // normalizeLabel strips "(" and ")", so approximateEnd's character walk lands
    // before the closing paren and the remainder begins with ")". extractAmountValue
    // requires the remainder to LEAD with a digit or currency symbol, so it declines.
    const d = doc([line("Zwischensumme (netto) 1.148,70", { y: 0.1 })]);
    expect(runRuleEngine(d).envelope.invoice.totals?.net).toBeUndefined();
  });

  it("the same line without the qualifier works", () => {
    const d = doc([line("Zwischensumme 1.148,70", { y: 0.1 })]);
    expect(runRuleEngine(d).envelope.invoice.totals?.net).toBe("1148.70");
  });

  knownBug("INVEX-034", "a parenthesised qualifier after a label defeats remainder extraction")
    .it("extracts the net total from 'Zwischensumme (netto)'", () => {
      // Not hypothetical: packages/fixtures/src/textPdf.ts:27 prints exactly this
      // label, so the canonical text fixture never extracts totals.net by rule —
      // R_NET_FROM_LINES repairs it instead, and docs/api.md's worked example records
      // that repair as if it were the expected path. A bug became the documented
      // behaviour because the fixture and the expectation share an author.
      const d = doc([line("Zwischensumme (netto) 1.148,70", { y: 0.1 })]);
      expect(runRuleEngine(d).envelope.invoice.totals?.net).toBe("1148.70");
    });
});
