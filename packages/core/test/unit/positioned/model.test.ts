import { describe, expect, it } from "vitest";
import { knownBug } from "../../../../../test-utils/knownBug";
import { bboxIntersects, inflate, normalizeLabel } from "../../../src/index";
import type { Bbox } from "../../../src/positioned/model";

describe("bboxIntersects", () => {
  it("is true for overlapping boxes", () => {
    const a: Bbox = [0.1, 0.1, 0.5, 0.5];
    const b: Bbox = [0.3, 0.3, 0.7, 0.7];
    expect(bboxIntersects(a, b)).toBe(true);
  });

  it("is false for disjoint boxes", () => {
    const a: Bbox = [0.1, 0.1, 0.2, 0.2];
    const b: Bbox = [0.5, 0.5, 0.6, 0.6];
    expect(bboxIntersects(a, b)).toBe(false);
  });

  it("is false for boxes that only touch along an edge (strict <)", () => {
    // a's right edge sits exactly on b's left edge — a common case for
    // adjacent table cells, which must NOT count as intersecting.
    const a: Bbox = [0.1, 0.1, 0.3, 0.3];
    const b: Bbox = [0.3, 0.1, 0.5, 0.3];
    expect(bboxIntersects(a, b)).toBe(false);
  });

  it("is false for boxes that only touch at a single corner", () => {
    const a: Bbox = [0.1, 0.1, 0.3, 0.3];
    const b: Bbox = [0.3, 0.3, 0.5, 0.5];
    expect(bboxIntersects(a, b)).toBe(false);
  });

  it("is true when one box fully contains the other", () => {
    const outer: Bbox = [0, 0, 1, 1];
    const inner: Bbox = [0.4, 0.4, 0.6, 0.6];
    expect(bboxIntersects(outer, inner)).toBe(true);
    expect(bboxIntersects(inner, outer)).toBe(true);
  });

  it("is false for a zero-area box against itself", () => {
    // x0<x2 must hold strictly for BOTH boxes' own x-span comparisons in the
    // formula (a[0]<b[2] and b[0]<a[2]) — with a===b that degenerates to
    // a[0]<a[2], which fails for a collapsed bbox. A region collapsed by
    // upstream normalization silently stops anchoring anything, even itself.
    const point: Bbox = [0.5, 0.5, 0.5, 0.5];
    expect(bboxIntersects(point, point)).toBe(false);
  });
});

describe("inflate", () => {
  it("expands a box on all sides by the given amount", () => {
    // 0.25/0.125 are exact in binary floating point, so this isn't sensitive
    // to inflate's subtract/add rounding.
    expect(inflate([0.25, 0.25, 0.5, 0.5], 0.125)).toEqual([0.125, 0.125, 0.625, 0.625]);
  });

  it("leaves the box unchanged for zero amount", () => {
    const b: Bbox = [0.3, 0.3, 0.5, 0.5];
    expect(inflate(b, 0)).toEqual(b);
  });

  it("clamps the low edge at 0", () => {
    expect(inflate([0.02, 0.02, 0.5, 0.5], 0.1)).toEqual([0, 0, 0.6, 0.6]);
  });

  it("clamps the high edge at 1", () => {
    expect(inflate([0.5, 0.5, 0.95, 0.95], 0.1)).toEqual([0.4, 0.4, 1, 1]);
  });
});

describe("normalizeLabel", () => {
  it("folds case", () => {
    expect(normalizeLabel("RECHNUNGSNUMMER")).toBe(normalizeLabel("rechnungsnummer"));
  });

  it("strips hyphens and periods so label variants line up", () => {
    // The header/rule-engine label side of a real invoice ("Rechnungs-Nr.")
    // must key-match a lexicon entry written without punctuation.
    expect(normalizeLabel("Rechnungs-Nr.")).toBe("rechnungsnr");
    expect(normalizeLabel("Rechnungs-Nr.")).toBe(normalizeLabel("rechnungsnr"));
  });

  it("decomposes umlauts via NFD and strips the combining diaeresis", () => {
    expect(normalizeLabel("Müller")).toBe("muller");
  });

  it("has no decomposition for ß, so it is dropped rather than expanded to 'ss'", () => {
    // NFD does not decompose ß (it isn't accent+base), so the punctuation
    // strip removes it whole. "Straße" and "Strasse" — the same word — end up
    // with DIFFERENT normalized keys ("strae" vs "strasse"), which is a real
    // label-matching hazard for German vendor headers using either spelling.
    expect(normalizeLabel("Straße")).toBe("strae");
    expect(normalizeLabel("Strasse")).toBe("strasse");
    expect(normalizeLabel("Straße")).not.toBe(normalizeLabel("Strasse"));
  });

  it("collapses internal and surrounding whitespace entirely", () => {
    expect(normalizeLabel("  Invoice   Number  ")).toBe("invoicenumber");
  });

  it("strips currency and grouping punctuation but keeps '%'", () => {
    expect(normalizeLabel("Total: $1,234.56")).toBe("total123456");
    expect(normalizeLabel("19%")).toBe("19%");
  });

  it("normalizes non-Latin scripts to the empty string", () => {
    // Cyrillic and Greek letters aren't in [a-z0-9%], so a Russian or Greek
    // invoice header collapses to "" — which the rule engine treats as "no
    // label", silently skipping the line rather than matching it.
    expect(normalizeLabel("Итого")).toBe("");
    expect(normalizeLabel("Σύνολο")).toBe("");
  });
});

describe("normalizeLabel — eszett", () => {
  knownBug("INVEX-032", "normalizeLabel drops ß instead of expanding it to ss")
    .it("normalizes 'Straße' and 'Strasse' to the same key", () => {
      // NFD decomposes umlauts but has no decomposition for ß, so it is stripped
      // by the [a-z0-9%] filter: "strae" vs "strasse". Both spellings are current
      // in German business writing, and this feeds label matching in the rule
      // engine and template apply. textquality/gate.ts already does ß -> ss;
      // this normalizer does not.
      expect(normalizeLabel("Straße")).toBe(normalizeLabel("Strasse"));
    });
});
