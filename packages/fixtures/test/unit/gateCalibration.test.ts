import { mapDoclingDocument, runTextGate } from "@invex/core";
import { describe, expect, it } from "vitest";
import { GATE_SAMPLES, gateSampleDoc, shiftEncoding } from "../../src/gateSamples";
import { goldenDocling, loadGoldens } from "../../src/goldens";

/**
 * INVEX-047 — the text gate used to reject legible documents.
 *
 * Found by the golden corpus, not by inspection, and confirmed in the field by
 * a real German Auftragsbestätigung that was rerouted to OCR and ultimately
 * exported as Markdown. Two compounding causes, both now closed:
 *
 *  1. runTextGate read `doc.lines` only. Line-item content arrives in
 *     `doc.tables`, so the gate judged the text LAYER while never seeing the
 *     part of the page carrying most of its words.
 *  2. `minDictHitRate: 0.55` asked "does this read like vocabulary I know?" of
 *     a 340-word list. Real pages score 0.33-0.48 against it. The dictionary
 *     rate is now a FLOOR — nothing recognisable anywhere — and consonant
 *     structure carries the actual discrimination.
 *
 * This file stays the calibration home because it needs REAL documents rather
 * than a hand-tuned synthetic one. It now measures two corpora: the goldens,
 * which are rendered pages, and `GATE_SAMPLES`, which is prose — the thing the
 * goldens are too short and too on-vocabulary to represent.
 */

const GATE = {
  minDictHitRate: 0.15,
  maxReplacementCharRatio: 0.05,
  maxSingleCharTokenRatio: 0.4,
  maxConsonantRunRatio: 0.35,
  minTokensForVerdict: 10,
};

const verdicts = loadGoldens().map((g) => {
  const mapped = mapDoclingDocument(goldenDocling(g));
  return { id: g.id, ...runTextGate(mapped, GATE) };
});

describe("text gate over the golden corpus", () => {
  it("passes every legible document in the corpus", () => {
    const garbage = verdicts.filter((v) => v.verdict === "garbage").map((v) => v.id);
    expect(garbage).toEqual([]);
  });

  it("reads the line-item text, which lives in the table", () => {
    // The half of INVEX-047 that no threshold change would have fixed: these
    // words are on the page, and the gate used not to see them at all.
    const g = loadGoldens().find((x) => x.id === "de-standard-19")!;
    const mapped = mapDoclingDocument(goldenDocling(g));
    const lineText = mapped.lines.map((l) => l.text).join(" ");
    expect(mapped.tables[0]!.rows.flat().join(" ")).toMatch(/Aktenvernichter/);
    expect(lineText).not.toMatch(/Aktenvernichter/);

    const linesOnly = runTextGate({ ...mapped, tables: [] }, GATE);
    expect(runTextGate(mapped, GATE).tokensConsidered).toBeGreaterThan(linesOnly.tokensConsidered);
  });

  it("[current] the three documents that used to fail now clear the floor by a wide margin", () => {
    // They scored 0.47-0.55 against the old 0.55 threshold — the margin that
    // made the old gate a coin toss is the reason the floor is where it is.
    for (const id of ["de-omitted-quantity-unitprice", "en-ungrouped-dot", "non-invoice-letter"]) {
      const v = verdicts.find((x) => x.id === id)!;
      expect(v.dictHitRate, id).toBeGreaterThan(GATE.minDictHitRate * 2);
      expect(v.consonantRunRatio, id).toBeLessThan(GATE.maxConsonantRunRatio);
    }
  });
});

describe("text gate over the prose corpus", () => {
  const results = GATE_SAMPLES.map((s) => ({
    sample: s,
    ...runTextGate(gateSampleDoc(s), GATE),
  }));

  it.each(GATE_SAMPLES.map((s) => [s.id, s.expect, s.shape] as const))(
    "%s (%s) — %s",
    (id, expected) => {
      const r = results.find((x) => x.sample.id === id)!;
      expect(r.verdict).toBe(expected === "legible" ? "ok" : "garbage");
    },
  );

  it("[current] real prose scores far under the dictionary threshold this gate used to apply", () => {
    // The measurement that condemns the old design: every one of these pages is
    // perfectly readable and every one of them would have been sent to OCR.
    const legible = results.filter((r) => r.sample.expect === "legible" && r.dictHitRate !== null);
    expect(legible.length).toBeGreaterThan(2);
    for (const r of legible) {
      expect(r.dictHitRate, r.sample.id).toBeLessThan(0.55);
      expect(r.verdict, r.sample.id).toBe("ok");
    }
  });

  it("separates a broken text layer from the same page read correctly", () => {
    // Same words, same layout, one broken ToUnicode table. A word list cannot
    // tell these apart by a useful margin; consonant structure can.
    const clean = results.find((r) => r.sample.id === "de-full-page")!;
    const broken = results.find((r) => r.sample.id === "de-full-page-broken-cmap")!;
    expect(clean.verdict).toBe("ok");
    expect(broken.verdict).toBe("garbage");
    expect(broken.consonantRunRatio).toBeGreaterThan(clean.consonantRunRatio * 5);
  });

  it("shiftEncoding preserves everything except the letters", () => {
    // Guards the corruption itself: if it also mangled spacing or punctuation
    // the garbage half would be catchable for the wrong reason.
    const source = "Zahlbar innerhalb von 30 Tagen, 3 % Skonto.";
    const shifted = shiftEncoding(source);
    expect(shifted).not.toBe(source);
    expect(shifted.length).toBe(source.length);
    expect(shifted.replace(/[a-zA-Z]/g, "")).toBe(source.replace(/[a-zA-Z]/g, ""));
  });
});
