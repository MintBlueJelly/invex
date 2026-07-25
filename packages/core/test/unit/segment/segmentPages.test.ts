import { describe, expect, it } from "vitest";
import { segmentPages, slicePages, type PositionedTextDocument } from "../../../src/index";
import { knownBug } from "../../../../../test-utils/knownBug";
import { doc, line } from "../../utils/positionedBuilders";

/**
 * Page segmentation (briefing §2 Path B step 2) — runs BEFORE classification so
 * a multi-invoice batch scan or an invoice with a trailing terms/AGB attachment
 * doesn't bleed unrelated pages into one table extraction. Deliberately
 * conservative: only strong signals (a heading, a restarted page counter) split.
 */

describe("page segmentation", () => {
  it("keeps a single-page invoice as one segment", () => {
    const d = doc([
      line("Rechnung", { y: 0.05, tag: "section_header" }),
      line("Rechnungs-Nr.: R-2026-0042", { y: 0.1 }),
      line("Gesamtbetrag: 119,00 EUR", { y: 0.7 }),
    ]);
    const segments = segmentPages(d);
    expect(segments).toEqual([{ pages: [1], kind: "invoice-candidate" }]);
  });

  it("splits a two-invoice batch scan on a repeated 'Seite 1 von 2'", () => {
    // A duplex scanner batch of two single-page invoices, each internally
    // paginated "1 of 2" against a cover sheet that never made it into the
    // digitized file — the counter restart is the only signal that page 2
    // starts a new invoice, not a continuation of page 1.
    const d: PositionedTextDocument = {
      pageCount: 2,
      tables: [],
      lines: [
        line("Rechnung", { page: 1, y: 0.05, tag: "section_header" }),
        line("Seite 1 von 2", { page: 1, y: 0.95 }),
        line("Gesamtbetrag: 119,00 EUR", { page: 1, y: 0.7 }),
        line("Rechnung", { page: 2, y: 0.05, tag: "section_header" }),
        line("Seite 1 von 2", { page: 2, y: 0.95 }),
        line("Gesamtbetrag: 50,00 EUR", { page: 2, y: 0.7 }),
      ],
    };
    const segments = segmentPages(d);
    expect(segments).toEqual([
      { pages: [1], kind: "invoice-candidate" },
      { pages: [2], kind: "invoice-candidate" },
    ]);
  });

  it("tags a trailing one-page AGB attachment as attachment, separate from the invoice", () => {
    const d: PositionedTextDocument = {
      pageCount: 2,
      tables: [],
      lines: [
        line("Rechnung", { page: 1, y: 0.05, tag: "section_header" }),
        line("Gesamtbetrag: 119,00 EUR", { page: 1, y: 0.7 }),
        line("Allgemeine Geschäftsbedingungen", { page: 2, y: 0.06, tag: "section_header" }),
        line("Es gilt deutsches Recht.", { page: 2, y: 0.12 }),
      ],
    };
    const segments = segmentPages(d);
    expect(segments).toEqual([
      { pages: [1], kind: "invoice-candidate" },
      { pages: [2], kind: "attachment" },
    ]);
  });

  // INVEX-016: isAttachmentStart only fires on the page carrying the AGB
  // heading. A real T&C attachment commonly runs 2-3 pages with the heading
  // on page one only — page two of a multi-page AGB has no heading, so the
  // segment "kind" flips back and the classifier receives boilerplate legal
  // text as an invoice candidate.
  describe("INVEX-016 — a multi-page attachment splits back into an invoice candidate", () => {
    function threePageDoc(): PositionedTextDocument {
      return {
        pageCount: 3,
        tables: [],
        lines: [
          line("Rechnung", { page: 1, y: 0.05, tag: "section_header" }),
          line("Gesamtbetrag: 119,00 EUR", { page: 1, y: 0.7 }),
          line("Allgemeine Geschäftsbedingungen", { page: 2, y: 0.06, tag: "section_header" }),
          line("Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts.", { page: 2, y: 0.12 }),
          line("Der Kunde verzichtet auf weitergehende Ansprüche gegen den Verkäufer.", { page: 3, y: 0.1 }),
          line("Gerichtsstand ist der Sitz des Verkäufers.", { page: 3, y: 0.2 }),
        ],
      };
    }

    it("[current] splits the AGB continuation page into its own invoice-candidate segment", () => {
      const segments = segmentPages(threePageDoc());
      expect(segments).toEqual([
        { pages: [1], kind: "invoice-candidate" },
        { pages: [2], kind: "attachment" },
        { pages: [3], kind: "invoice-candidate" },
      ]);
    });

    knownBug("INVEX-016", "an AGB continuation page with no heading starts a new invoice-candidate segment").it(
      "keeps both AGB pages in one attachment segment",
      () => {
        const segments = segmentPages(threePageDoc());
        expect(segments).toEqual([
          { pages: [1], kind: "invoice-candidate" },
          { pages: [2, 3], kind: "attachment" },
        ]);
      },
    );
  });

  it("slicePages renumbers pages, and filters lines and tables to the kept set", () => {
    const d: PositionedTextDocument = {
      pageCount: 3,
      tables: [
        { page: 1, bbox: [0, 0, 1, 1], headerCells: ["a"], rows: [["1"]] },
        { page: 2, bbox: [0, 0, 1, 1], headerCells: ["b"], rows: [["2"]] },
        { page: 3, bbox: [0, 0, 1, 1], headerCells: ["c"], rows: [["3"]] },
      ],
      lines: [
        line("page1 line", { page: 1, y: 0.1 }),
        line("page2 line", { page: 2, y: 0.1 }),
        line("page3 line", { page: 3, y: 0.1 }),
      ],
    };
    // Keep pages 1 and 3 (drop the AGB page in the middle) — they must renumber
    // to 1 and 2, contiguous, with page 2's line and table gone entirely.
    const sliced = slicePages(d, [1, 3]);
    expect(sliced.pageCount).toBe(2);
    expect(sliced.lines.map((l) => [l.text, l.page])).toEqual([
      ["page1 line", 1],
      ["page3 line", 2],
    ]);
    expect(sliced.tables.map((t) => [t.headerCells[0], t.page])).toEqual([
      ["a", 1],
      ["c", 2],
    ]);
    expect(sliced.lines.every((l) => l.tokens.every((t) => t.page === l.page))).toBe(true);
  });

  it("slices a single page out of the middle down to a one-page document", () => {
    const d: PositionedTextDocument = {
      pageCount: 3,
      tables: [
        { page: 1, bbox: [0, 0, 1, 1], headerCells: ["a"], rows: [["1"]] },
        { page: 2, bbox: [0, 0, 1, 1], headerCells: ["b"], rows: [["2"]] },
        { page: 3, bbox: [0, 0, 1, 1], headerCells: ["c"], rows: [["3"]] },
      ],
      lines: [
        line("page1 line", { page: 1, y: 0.1 }),
        line("page2 line", { page: 2, y: 0.1 }),
        line("page3 line", { page: 3, y: 0.1 }),
      ],
    };
    const sliced = slicePages(d, [2]);
    expect(sliced.pageCount).toBe(1);
    expect(sliced.lines).toHaveLength(1);
    expect(sliced.lines[0]).toMatchObject({ text: "page2 line", page: 1 });
    expect(sliced.tables).toEqual([{ page: 1, bbox: [0, 0, 1, 1], headerCells: ["b"], rows: [["2"]] }]);
  });

  // Unassigned defects — no INVEX id issued for these; documented in the report
  // rather than pinned, per the review's "do not invent an id" instruction.
  describe("unassigned defects (documented, not pinned)", () => {
    it("[current] a pageCount:0 document falls back to one segment with zero pages", () => {
      // Nothing downstream rejects an empty page list — the fallback branch
      // in segmentPages exists for "no pages produced a segment", but a
      // zero-page source document takes the exact same path silently.
      const d: PositionedTextDocument = { pageCount: 0, lines: [], tables: [] };
      const segments = segmentPages(d);
      expect(segments).toEqual([{ pages: [], kind: "invoice-candidate" }]);
    });

    it("[current] slicePages renumbers a token whose own page is outside the slice to page 1, instead of dropping it", () => {
      // Constructed inconsistency: the LINE says page 1 (kept), but one of its
      // tokens carries page 2 (dropped) — the kind of disagreement a buggy
      // upstream mapper could produce. `order.get(t.page) ?? 1` silently
      // relabels that token onto page 1 rather than treating it as orphaned.
      const mismatched: PositionedTextDocument = {
        pageCount: 2,
        tables: [],
        lines: [
          {
            text: "weird line",
            page: 1,
            bbox: [0, 0, 1, 1],
            tokens: [
              { text: "weird", page: 1, bbox: [0, 0, 0.5, 1] },
              { text: "line", page: 2, bbox: [0.5, 0, 1, 1] },
            ],
          },
        ],
      };
      const sliced = slicePages(mismatched, [1]);
      expect(sliced.lines[0]?.tokens.map((t) => t.page)).toEqual([1, 1]);
    });
  });
});
