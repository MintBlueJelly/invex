import { mapDoclingDocument, runTextGate } from "@invex/core";
import { describe, expect, it } from "vitest";
import { knownBug } from "../../../../test-utils/knownBug";
import { goldenDocling, loadGoldens } from "../../src/goldens";

/**
 * INVEX-047 — the text gate rejects legible invoices.
 *
 * Found by the golden corpus, not by inspection, and it lives here rather than
 * in core because it needs REAL rendered documents rather than a hand-tuned
 * synthetic one — the whole point is what happens to an ordinary page.
 *
 * Two compounding causes:
 *  1. runTextGate reads `doc.lines` only. Line-item content arrives in
 *     `doc.tables`, so the gate judges the text LAYER while never seeing the
 *     part of the page carrying most of its words.
 *  2. What remains — letterhead, labels, amounts, proper nouns, article codes —
 *     is not prose, and 0.55 is far too high a dictionary hit rate for it.
 *
 * The cost falls on exactly the path the design exists to widen: a perfectly
 * legible invoice is rerouted to OCR, and for an unknown vendor that means the
 * GPU. The previous suite could not see this — it had one text fixture, which
 * happens to score 0.65.
 */

const GATE = {
  minDictHitRate: 0.55,
  maxReplacementCharRatio: 0.05,
  maxSingleCharTokenRatio: 0.4,
  minTokensForVerdict: 10,
};

const verdicts = loadGoldens().map((g) => {
  const mapped = mapDoclingDocument(goldenDocling(g));
  return { id: g.id, ...runTextGate(mapped, GATE) };
});

describe("text gate over the golden corpus", () => {
  it("[current] several ordinary documents are judged garbage", () => {
    const garbage = verdicts.filter((v) => v.verdict === "garbage").map((v) => v.id);
    // Two ordinary invoices and a plain German business letter.
    expect(garbage).toContain("de-omitted-quantity-unitprice");
    expect(garbage).toContain("en-ungrouped-dot");
    expect(garbage).toContain("non-invoice-letter");
  });

  it("[current] their dictionary hit rates sit just under the threshold", () => {
    for (const id of ["de-omitted-quantity-unitprice", "en-ungrouped-dot"]) {
      const v = verdicts.find((x) => x.id === id)!;
      expect(v.dictHitRate, id).toBeLessThan(GATE.minDictHitRate);
      expect(v.dictHitRate, id).toBeGreaterThan(0.5);
    }
  });

  it("[current] the gate never sees line-item text", () => {
    // The words are on the page, in the table — the gate simply does not read
    // them. This is the half of the defect that a threshold change would not fix.
    const g = loadGoldens().find((x) => x.id === "de-standard-19")!;
    const mapped = mapDoclingDocument(goldenDocling(g));
    const lineText = mapped.lines.map((l) => l.text).join(" ");
    expect(mapped.tables[0]!.rows.flat().join(" ")).toMatch(/Aktenvernichter/);
    expect(lineText).not.toMatch(/Aktenvernichter/);
  });

  knownBug("INVEX-047", "minDictHitRate rejects legible invoices; the gate never reads table text")
    .it("passes every legible document in the corpus", () => {
      const garbage = verdicts.filter((v) => v.verdict === "garbage").map((v) => v.id);
      expect(garbage).toEqual([]);
    });
});
