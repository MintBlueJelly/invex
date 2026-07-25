import { describe, expect, it } from "vitest";
import { runTextGate, type TextGateOptions } from "../../../src/index";
import { knownBug } from "../../../../../test-utils/knownBug";
import { doc, line } from "../../utils/positionedBuilders";

/**
 * Text-quality gate (briefing §2 Path B step 1) — decides whether a PDF's
 * embedded text layer is trustworthy enough to feed the rule engine/classifier,
 * or must be rerouted to OCR (Path C). Values match the committed
 * `config/pipeline.json` → `textGate` block.
 */
const gateOpts: TextGateOptions = {
  minDictHitRate: 0.55,
  maxReplacementCharRatio: 0.05,
  maxSingleCharTokenRatio: 0.4,
  minTokensForVerdict: 10,
};

/** Pads a phrase with itself to an exact character count, for ratio boundary tests. */
function repeatToLength(phrase: string, targetLen: number): string {
  let s = "";
  while (s.length < targetLen) s += `${phrase} `;
  return s.slice(0, targetLen);
}

/** `n` single-letter tokens (e.g. stray OCR key-cap noise) among `total` real words. */
function singleCharDoc(n: number, total: number) {
  const singles = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26)));
  const rest = Array.from({ length: total - n }, () => "Rechnung");
  return doc([line([...singles, ...rest].join(" "))]);
}

describe("text-quality gate", () => {
  it("passes real German invoice prose with a high dictionary hit rate", () => {
    // Real letterhead prose, including compounds ("Gesamtbetrag", "Lieferungen")
    // that only hit via the compound-aware substring match, not an exact word.
    const d = doc([
      line("Rechnung über Lieferungen und Leistungen gemäß unserem Vertrag"),
      line("Zahlbar innerhalb von dreißig Tagen ohne jeglichen Abzug auf folgendes Konto"),
      line("Gesamtbetrag einschließlich der gesetzlichen Mehrwertsteuer und Versandkosten"),
    ]);
    const r = runTextGate(d, gateOpts);
    expect(r.verdict).toBe("ok");
    expect(r.dictHitRate).toBeGreaterThan(0.6);
    expect(r.reasons).toEqual([]);
  });

  it("passes English prose too — the dictionary is bilingual", () => {
    const d = doc([
      line("Invoice for services and products delivered under contract"),
      line("Payment is due within thirty days without any deduction please"),
      line("Total amount including applicable tax and delivery charges"),
    ]);
    const r = runTextGate(d, gateOpts);
    expect(r.verdict).toBe("ok");
    expect(r.dictHitRate).toBeGreaterThan(0.6);
  });

  it("flags cid-token garbage regardless of dictionary score", () => {
    // A Docling text layer that fell back to raw glyph ids on an embedded-font
    // page: real invoice prose surrounds three (cid:NNN) markers. Dict score
    // alone would pass this; the cid check must veto independently.
    const d = doc([
      line("Rechnung über Lieferungen und Leistungen gemäß unserem Vertrag"),
      line("Zahlbar innerhalb von dreißig Tagen ohne jeglichen Abzug auf folgendes Konto"),
      line("(cid:12) (cid:34) (cid:56)"),
    ]);
    const r = runTextGate(d, gateOpts);
    expect(r.dictHitRate).toBeGreaterThan(gateOpts.minDictHitRate);
    expect(r.verdict).toBe("garbage");
    expect(r.cidTokens).toBe(3);
    expect(r.reasons).toEqual(["cid_tokens=3"]);
  });

  it("flags consonant-soup OCR junk via dictionary hit rate", () => {
    const d = doc([
      line("qzwx vbnk jhgf pqzt wxcv bnmk lkjh gfds"),
      line("trwq zxcv bnml kjhg fdsa qwrt zxcb nmlk"),
    ]);
    const r = runTextGate(d, gateOpts);
    expect(r.verdict).toBe("garbage");
    expect(r.dictHitRate).toBe(0);
    expect(r.tokensConsidered).toBe(16);
    expect(r.reasons).toEqual(["dict_hit_rate=0.00"]);
  });

  it("stays under the replacement-char ratio just below the threshold", () => {
    // 9 U+FFFD in 200 chars = 0.045, under the 0.05 gate — a handful of
    // unmappable glyphs a scanner drops in, not a garbage page.
    const base = repeatToLength("Rechnung Zahlung Konto Datum Betrag Kunde Vertrag Termin Nummer Adresse", 190);
    const r = runTextGate(doc([line(`${base} ${"�".repeat(9)}`)]), gateOpts);
    expect(r.replacementRatio).toBe(0.045);
    expect(r.verdict).toBe("ok");
    expect(r.reasons).toEqual([]);
  });

  it("flags the replacement-char ratio just above the threshold", () => {
    // Same shape, one more U+FFFD tips 11/201 = 0.0547 over 0.05.
    const base = repeatToLength("Rechnung Zahlung Konto Datum Betrag Kunde Vertrag Termin Nummer Adresse", 189);
    const r = runTextGate(doc([line(`${base} ${"�".repeat(11)}`)]), gateOpts);
    expect(r.replacementRatio).toBe(11 / 201);
    expect(r.verdict).toBe("garbage");
    expect(r.reasons).toEqual(["replacement_ratio=0.055"]);
  });

  it("stays under the single-char-token ratio just below the threshold", () => {
    // 40 stray single-letter tokens (page-number footnote markers, OCR noise)
    // among 100 words = 0.40, exactly at the gate — not over it.
    const r = runTextGate(singleCharDoc(40, 100), gateOpts);
    expect(r.singleCharRatio).toBe(0.4);
    expect(r.verdict).toBe("ok");
    expect(r.reasons).toEqual([]);
  });

  it("flags the single-char-token ratio just above the threshold", () => {
    const r = runTextGate(singleCharDoc(41, 100), gateOpts);
    expect(r.singleCharRatio).toBe(0.41);
    expect(r.verdict).toBe("garbage");
    expect(r.reasons).toEqual(["single_char_ratio=0.41"]);
  });

  it("does not compute a dict hit rate one token short of minTokensForVerdict", () => {
    // 9 considered tokens, every one a dictionary hit — still null, not "1.0".
    const words = ["Rechnung", "Zahlung", "Konto", "Datum", "Betrag", "Kunde", "Preis", "Menge", "Vertrag"];
    const r = runTextGate(doc([line(words.join(" "))]), gateOpts);
    expect(r.tokensConsidered).toBe(9);
    expect(r.dictHitRate).toBeNull();
    expect(r.verdict).toBe("ok");
  });

  it("computes a dict hit rate exactly at minTokensForVerdict", () => {
    const words = ["Rechnung", "Zahlung", "Konto", "Datum", "Betrag", "Kunde", "Preis", "Menge", "Vertrag", "Termin"];
    const r = runTextGate(doc([line(words.join(" "))]), gateOpts);
    expect(r.tokensConsidered).toBe(10);
    expect(r.dictHitRate).toBe(1);
    expect(r.verdict).toBe("ok");
  });

  it("reports the exact result shape for a clean document", () => {
    const d = doc([
      line("Rechnung über Lieferungen und Leistungen gemäß unserem Vertrag"),
      line("Zahlbar innerhalb von dreißig Tagen ohne jeglichen Abzug auf folgendes Konto"),
      line("Gesamtbetrag einschließlich der gesetzlichen Mehrwertsteuer und Versandkosten"),
    ]);
    expect(runTextGate(d, gateOpts)).toEqual({
      verdict: "ok",
      dictHitRate: 14 / 21,
      cidTokens: 0,
      replacementRatio: 0,
      singleCharRatio: 0,
      tokensConsidered: 21,
      reasons: [],
    });
  });

  it("reports the exact result shape for a cid-garbage document", () => {
    const d = doc([
      line("Rechnung über Lieferungen und Leistungen gemäß unserem Vertrag"),
      line("Zahlbar innerhalb von dreißig Tagen ohne jeglichen Abzug auf folgendes Konto"),
      line("(cid:12) (cid:34) (cid:56)"),
    ]);
    expect(runTextGate(d, gateOpts)).toEqual({
      verdict: "garbage",
      dictHitRate: 11 / 16,
      cidTokens: 3,
      replacementRatio: 0,
      singleCharRatio: 0,
      tokensConsidered: 16,
      reasons: ["cid_tokens=3"],
    });
  });

  // INVEX-015: dictHitRate is only computed once `considered.length >=
  // minTokensForVerdict`; below that the gate reports zero reasons and
  // verdicts "ok" — indistinguishable from a genuinely clean page. Three
  // shapes trigger it in practice: a blank page (failed extraction), a
  // numbers-only page (e.g. a bank statement scanned with no OCR), and a
  // short garbage fragment (a stray junk header/footer line).
  describe("INVEX-015 — not-enough-evidence documents pass as ok", () => {
    it("[current] verdicts a fully empty document as ok", () => {
      const r = runTextGate(doc([]), gateOpts);
      expect(r.tokensConsidered).toBe(0);
      expect(r.dictHitRate).toBeNull();
      expect(r.verdict).toBe("ok");
    });

    knownBug("INVEX-015", "an empty document verdicts ok instead of signalling insufficient evidence").it(
      "does not verdict an empty document as usable",
      () => {
        const r = runTextGate(doc([]), gateOpts);
        expect(r.verdict).not.toBe("ok");
      },
    );

    it("[current] verdicts an all-digits document as ok", () => {
      // No letters at all: rawTokens splits on \p{L} runs, so digits never
      // even become alpha tokens — dictHitRate is null, not "bad".
      const r = runTextGate(doc([line("123456 7890123 456789012 3456789 01234")]), gateOpts);
      expect(r.tokensConsidered).toBe(0);
      expect(r.dictHitRate).toBeNull();
      expect(r.verdict).toBe("ok");
    });

    knownBug("INVEX-015", "a numbers-only document verdicts ok instead of signalling insufficient evidence").it(
      "does not verdict an all-digits document as usable",
      () => {
        const r = runTextGate(doc([line("123456 7890123 456789012 3456789 01234")]), gateOpts);
        expect(r.verdict).not.toBe("ok");
      },
    );

    it("[current] verdicts a 5-token garbage fragment as ok", () => {
      // Genuinely junk tokens, but only 5 of them — under minTokensForVerdict,
      // so the dictionary check that would catch this never runs.
      const r = runTextGate(doc([line("qzwx vbnk jhgf pqzt wxcv")]), gateOpts);
      expect(r.tokensConsidered).toBe(5);
      expect(r.dictHitRate).toBeNull();
      expect(r.verdict).toBe("ok");
    });

    knownBug("INVEX-015", "a short garbage fragment verdicts ok instead of signalling insufficient evidence").it(
      "does not verdict a short garbage fragment as usable",
      () => {
        const r = runTextGate(doc([line("qzwx vbnk jhgf pqzt wxcv")]), gateOpts);
        expect(r.verdict).not.toBe("ok");
      },
    );
  });
});
