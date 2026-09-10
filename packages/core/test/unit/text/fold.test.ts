import { describe, expect, it } from "vitest";
import { foldText, spellingVariants } from "../../../src/text/fold";

describe("foldText", () => {
  it("lowercases", () => {
    expect(foldText("RECHNUNG")).toBe("rechnung");
  });

  it("maps ß to ss", () => {
    expect(foldText("Straße")).toBe("strasse");
    expect(foldText("Großhandel")).toBe("grosshandel");
  });

  it("strips umlaut diacritics without dropping the base letter", () => {
    expect(foldText("Auftragsbestätigung")).toBe("auftragsbestatigung");
    expect(foldText("Kostenschätzung")).toBe("kostenschatzung");
    expect(foldText("Prüfung")).toBe("prufung");
    expect(foldText("Fällig")).toBe("fallig");
  });

  it("strips non-German diacritics too", () => {
    expect(foldText("Café")).toBe("cafe");
    expect(foldText("Æther")).toBe("aether");
  });

  it("folds a decomposed umlaut identically to a precomposed one", () => {
    const precomposed = "Bestätigung";
    const decomposed = "Bestätigung";
    expect(precomposed).not.toBe(decomposed);
    expect(foldText(decomposed)).toBe(foldText(precomposed));
  });

  // The whole reason this helper exists rather than reusing normalizeLabel.
  describe("preserves separators so \\b survives", () => {
    it("keeps whitespace, hyphens and periods", () => {
      expect(foldText("Rechnungs-Nr. 42 / A")).toBe("rechnungs-nr. 42 / a");
    });

    it("still refuses to match a stem inside a compound", () => {
      expect(/\brechnung\b/.test(foldText("Rechnungsdatum"))).toBe(false);
      expect(/\brechnung\b/.test(foldText("Schlussrechnung"))).toBe(false);
      expect(/\brechnung\b/.test(foldText("Rechnungskorrektur"))).toBe(false);
    });

    it("matches a whole word at a separator boundary", () => {
      expect(/\brechnung\b/.test(foldText("Rechnung Nr. 42"))).toBe(true);
      expect(/\bstornorechnung\b/.test(foldText("Stornorechnung"))).toBe(true);
      // "-" is a non-word character, so the tail of a hyphenated compound does
      // match. Precedence, not the regex, is what keeps that a creditNote.
      expect(/\brechnung\b/.test(foldText("Storno-Rechnung"))).toBe(true);
    });
  });

  // The anti-case for the rejected "collapse ae/oe/ue" design: it would have
  // mapped steuer -> stur and silently killed F3's and F5's keyword sets.
  it("does not collapse ue/oe/ae, so the tax lexicon survives", () => {
    expect(foldText("Steuernummer")).toBe("steuernummer");
    expect(foldText("Mehrwertsteuer")).toBe("mehrwertsteuer");
    expect(foldText("neue")).toBe("neue");
  });
});

describe("spellingVariants", () => {
  it("returns both the folded and the transliterated spelling", () => {
    expect(spellingVariants("Auftragsbestätigung")).toEqual([
      "auftragsbestatigung",
      "auftragsbestaetigung",
    ]);
  });

  it("handles ö and ü", () => {
    expect(spellingVariants("Größe")).toEqual(["grosse", "groesse"]);
    expect(spellingVariants("Prüfung")).toEqual(["prufung", "pruefung"]);
  });

  it("collapses to one entry when the term has no umlaut", () => {
    expect(spellingVariants("Lieferschein")).toEqual(["lieferschein"]);
    expect(spellingVariants("Invoice")).toEqual(["invoice"]);
  });

  it("covers uppercase umlauts", () => {
    expect(spellingVariants("ÜBERWEISUNG")).toEqual(["uberweisung", "ueberweisung"]);
  });
});
