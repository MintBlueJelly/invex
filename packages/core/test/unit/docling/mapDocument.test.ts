import { describe, expect, it } from "vitest";
import { mapDoclingDocument } from "../../../src/index";

/**
 * INVEX-005 — a missing page size must not silently collapse all geometry.
 *
 * normBbox divided by `page.size.width ?? 1`. With no page entry every
 * coordinate became a raw point value divided by 1, then clamped to [0,1] —
 * so every bbox in the document became [1,1,1,1]. Everything downstream is
 * positional: region anchors, the classifier's "heading in the top quarter"
 * test, the segmenter, and the OCR x-bands. All of them then operate on
 * degenerate coordinates, and nothing reports it.
 *
 * This matters more than a normal parsing bug because the mapper is the ONLY
 * place that knows docling's shape, it was written against documentation rather
 * than a captured response, and the compose file pins an older docling than the
 * reference deployment runs.
 */

const A4_W = 595.276;
const A4_H = 841.89;

function text(t: string, bbox: { l: number; t: number; r: number; b: number }) {
  return { text: t, prov: [{ page_no: 1, bbox: { ...bbox, coord_origin: "TOPLEFT" } }] };
}

describe("mapDoclingDocument — page size", () => {
  it("normalizes against the declared page size", () => {
    const doc = mapDoclingDocument({
      pages: { "1": { page_no: 1, size: { width: 1000, height: 2000 } } },
      texts: [text("Rechnung", { l: 100, t: 200, r: 500, b: 300 })],
    });
    expect(doc.lines[0]!.bbox).toEqual([0.1, 0.1, 0.5, 0.15]);
  });

  it("falls back to A4 when the page size is missing, instead of collapsing to [1,1,1,1]", () => {
    const doc = mapDoclingDocument({
      pages: {},
      texts: [text("Rechnung", { l: A4_W / 4, t: A4_H / 10, r: A4_W / 2, b: A4_H / 5 })],
    });
    const [x0, y0, x1, y1] = doc.lines[0]!.bbox;
    expect(x0).toBeCloseTo(0.25, 3);
    expect(y0).toBeCloseTo(0.1, 3);
    expect(x1).toBeCloseTo(0.5, 3);
    expect(y1).toBeCloseTo(0.2, 3);
  });

  it("keeps a heading in the top quarter of the page under the fallback", () => {
    // The concrete downstream consequence: classifier F1 requires the heading to
    // sit above y=0.25. Collapsed geometry put it at y=1 and the feature could
    // never fire, silently costing 3 of the 12 available classifier points.
    const doc = mapDoclingDocument({
      pages: {},
      texts: [text("Rechnung", { l: 50, t: 60, r: 200, b: 80 })],
    });
    expect(doc.lines[0]!.bbox[1]).toBeLessThan(0.25);
  });

  it("throws when the geometry provably does not fit the fallback", () => {
    // A3, a landscape page, or a docling schema change — anything where the
    // assumption is demonstrably wrong. Failing loudly makes the document
    // escalate; guessing would extract plausible-looking nonsense.
    expect(() =>
      mapDoclingDocument({
        pages: {},
        texts: [text("Rechnung", { l: 100, t: 100, r: 1400, b: 200 })],
      }),
    ).toThrow(/page size/i);
  });

  it("does not throw when a declared page size is present, whatever its dimensions", () => {
    expect(() =>
      mapDoclingDocument({
        pages: { "1": { page_no: 1, size: { width: 1684, height: 2384 } } },
        texts: [text("Rechnung", { l: 100, t: 100, r: 1400, b: 200 })],
      }),
    ).not.toThrow();
  });
});
