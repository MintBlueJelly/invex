import { describe, expect, it } from "vitest";
import { mergeLines } from "../../../src/index";
import type { PositionedTextDocument } from "../../../src/positioned/model";
import { columnLine, doc, line } from "../../utils/positionedBuilders";
import { knownBug } from "../../../../../test-utils/knownBug";

// mergeLines' own default; kept explicit so boundary tests don't silently
// drift if the default ever changes.
const TOL = 0.008;

function docOf(lines: PositionedTextDocument["lines"], pageCount = 1): PositionedTextDocument {
  return { pageCount, lines, tables: [] };
}

describe("mergeLines", () => {
  it("merges word fragments on the same baseline into one line", () => {
    const left = line("Invoice", { x: 0.05, width: 0.15, y: 0.2 });
    const right = line("Total", { x: 0.25, width: 0.15, y: 0.2 });
    const merged = mergeLines(docOf([left, right]));
    expect(merged.lines).toHaveLength(1);
    expect(merged.lines[0]!.text).toBe("Invoice Total");
    expect(merged.lines[0]!.tokens).toHaveLength(2);
  });

  it("keeps lines on clearly different baselines apart", () => {
    const header = line("Header", { y: 0.1 });
    const footer = line("Footer", { y: 0.5 });
    const merged = mergeLines(docOf([header, footer]));
    expect(merged.lines).toHaveLength(2);
    expect(merged.lines.map((l) => l.text)).toEqual(["Header", "Footer"]);
  });

  it("joins merged text and orders tokens left-to-right regardless of input order", () => {
    // Fed right-to-left, as a table-row OCR pass might emit fragments out of order.
    const c = columnLine([{ text: "C", x: 0.6 }], { y: 0.3 });
    const b = columnLine([{ text: "B", x: 0.3 }], { y: 0.3 });
    const a = columnLine([{ text: "A", x: 0.05 }], { y: 0.3 });
    const merged = mergeLines(docOf([c, b, a]));
    expect(merged.lines).toHaveLength(1);
    expect(merged.lines[0]!.text).toBe("A B C");
    expect(merged.lines[0]!.tokens.map((t) => t.text)).toEqual(["A", "B", "C"]);
  });

  it("merges a cluster the same way regardless of which fragment arrives first", () => {
    const a = line("A", { x: 0.05, y: 0.2 });
    const b = line("B", { x: 0.5, y: 0.2 });
    const forward = mergeLines(docOf([a, b]));
    const reversed = mergeLines(docOf([b, a]));
    expect(reversed).toEqual(forward);
    expect(forward.lines[0]!.text).toBe("A B");
  });

  it("merges two lines whose centers differ by just under yTolerance", () => {
    const a = line("Row1", { y: 0.1 });
    const b = line("Row2", { y: 0.1 + TOL - 0.0005 });
    const merged = mergeLines(docOf([a, b]), TOL);
    expect(merged.lines).toHaveLength(1);
  });

  it("does not merge two lines whose centers differ by just over yTolerance", () => {
    const a = line("Row1", { y: 0.1 });
    const b = line("Row2", { y: 0.1 + TOL + 0.0005 });
    const merged = mergeLines(docOf([a, b]), TOL);
    expect(merged.lines).toHaveLength(2);
  });

  it("merges two lines whose centers differ by exactly yTolerance (boundary is inclusive)", () => {
    // The guard is `> yTolerance`, so an equal difference does not trigger a flush.
    const a = line("Row1", { y: 0.1 });
    const b = line("Row2", { y: 0.1 + TOL });
    const merged = mergeLines(docOf([a, b]), TOL);
    expect(merged.lines).toHaveLength(1);
  });

  it("never merges lines on different pages, even at identical y", () => {
    const p1 = line("Same", { y: 0.2, page: 1 });
    const p2 = line("Same", { y: 0.2, page: 2 });
    const merged = mergeLines(docOf([p1, p2], 2));
    expect(merged.lines).toHaveLength(2);
    expect(merged.lines.map((l) => l.page).sort()).toEqual([1, 2]);
  });

  it("propagates a tag from either fragment onto the merged line", () => {
    const untaggedFirst = mergeLines(
      docOf([line("Invoice", { x: 0.05, y: 0.2 }), line("Number", { x: 0.5, y: 0.2, tag: "section_header" })]),
    );
    expect(untaggedFirst.lines[0]!.tag).toBe("section_header");

    const taggedFirst = mergeLines(
      docOf([line("Invoice", { x: 0.05, y: 0.2, tag: "title" }), line("Number", { x: 0.5, y: 0.2 })]),
    );
    expect(taggedFirst.lines[0]!.tag).toBe("title");
  });

  it("is idempotent: re-running on already-merged output changes nothing", () => {
    const d = doc(["Invoice Number: 12345", "Total: 99.90"]);
    const once = mergeLines(d);
    const twice = mergeLines(once);
    expect(twice).toEqual(once);
  });

  it("produces the same result regardless of the input lines' order", () => {
    const d = doc(["Alpha", "Bravo", "Charlie"]); // distinct baselines, no merging involved
    const shuffled = docOf([d.lines[2]!, d.lines[0]!, d.lines[1]!]);
    expect(mergeLines(shuffled)).toEqual(mergeLines(d));
  });

  it("returns an empty document unchanged", () => {
    const empty = docOf([]);
    expect(mergeLines(empty)).toEqual(empty);
  });

  describe("INVEX-014 — cluster drift", () => {
    // Five lines spaced 0.007 apart (just under the 0.008 default yTolerance):
    // each is within tolerance of its NEIGHBOR, but the first and last are
    // 0.028 apart — four times the tolerance.
    const step = 0.007;
    const rungs = Array.from({ length: 5 }, (_, i) => line(`Row${i}`, { y: 0.1 + i * step }));

    it("[current] collapses the whole ladder into a single merged line", () => {
      const merged = mergeLines(docOf(rungs), TOL);
      expect(merged.lines).toHaveLength(1);
      expect(merged.lines[0]!.text).toBe("Row0 Row1 Row2 Row3 Row4");
    });

    knownBug(
      "INVEX-014",
      "mergeLines compares each line to the previous one instead of the cluster's origin, so a ladder of lines each within tolerance of its neighbor drifts arbitrarily far",
    ).it("keeps every merged line's constituents within yTolerance of each other", () => {
      const merged = mergeLines(docOf(rungs), TOL);
      for (const l of merged.lines) {
        // Every token in a correctly-merged line came from an original line
        // within yTolerance of every other; single-word lines mean one token
        // per original line, so token y-centers double as per-line centers.
        const centers = l.tokens.map((t) => (t.bbox[1] + t.bbox[3]) / 2);
        const spread = Math.max(...centers) - Math.min(...centers);
        expect(spread).toBeLessThanOrEqual(TOL);
      }
    });
  });
});
