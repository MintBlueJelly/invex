import type { DrawOp, DrawRole, PageLayout, TableRegion } from "../layout/invoiceLayout";
import { opWidth } from "../layout/invoiceLayout";

/**
 * PageLayout -> DoclingDocument JSON, Path B's input shape (mapDocument.ts).
 * `tableHeader`/`cell` ops are DELIBERATELY skipped when building `texts`: a
 * real docling response never repeats table content there once TableFormer
 * has claimed it as a `tables[]` region, so `PageLayout.tables` is the only
 * source for cell text — matching that contract, not merely resembling it.
 */

export interface RenderDoclingJsonOptions {
  coordOrigin?: "BOTTOMLEFT" | "TOPLEFT";
  omitPageSize?: boolean;
  multiRowHeader?: boolean;
}

/** Vertical padding added below the font size to approximate a text cell's height. */
const LINE_PAD = 4;

function bboxFor(
  l: number,
  t: number,
  r: number,
  b: number,
  origin: "BOTTOMLEFT" | "TOPLEFT",
  pageHeight: number,
): { l: number; t: number; r: number; b: number; coord_origin: string } {
  if (origin === "BOTTOMLEFT") {
    return { l, r, t: pageHeight - t, b: pageHeight - b, coord_origin: "BOTTOMLEFT" };
  }
  return { l, r, t, b, coord_origin: "TOPLEFT" };
}

/**
 * The segmenter (segmentPages.ts) only recognizes "section_header" for the
 * invoice-heading regex; docling's "title" label reads the same to the
 * classifier but NOT to the segmenter, so headings are tagged section_header
 * specifically rather than "title" — there is no role here for which "title"
 * is the better match.
 */
function doclingLabel(role: DrawRole): string {
  return role === "heading" ? "section_header" : "text";
}

/**
 * Ops sharing a page+yTop+role are one visual line (e.g. a headerField's
 * label/value pair, or a totals row's label/value pair — both pushed at the
 * same yTop by invoiceLayout). Role is part of the key, not just page+yTop,
 * because the heading and the first headerField row legitimately land on the
 * same yTop by construction (both start at `headingY`) yet are unrelated,
 * far-apart text blocks that a real docling response would never merge.
 */
function groupOpsIntoLines(ops: DrawOp[]): DrawOp[][] {
  const groups = new Map<string, DrawOp[]>();
  for (const op of ops) {
    if (op.role === "tableHeader" || op.role === "cell") continue;
    const key = `${op.page}:${op.yTop}:${op.role}`;
    const group = groups.get(key);
    if (group) group.push(op);
    else groups.set(key, [op]);
  }
  return [...groups.values()].map((group) => [...group].sort((a, b) => a.x - b.x));
}

function buildTable(
  table: TableRegion,
  pageHeight: number,
  origin: "BOTTOMLEFT" | "TOPLEFT",
  multiRowHeader: boolean,
): unknown {
  const numCols = table.headerCells.length;
  const headerRowCount = multiRowHeader ? 2 : 1;
  const cells: unknown[] = [];

  if (multiRowHeader) {
    // A blank super-header row above the real column names. Its cells are
    // empty, so the mapper's per-column join (`.filter(v => v !== "")`)
    // reduces back to exactly the single-row header text — this exercises
    // the multi-row merge path without changing what the header actually says.
    table.headerCells.forEach((_, col) => {
      cells.push({
        text: "",
        start_row_offset_idx: 0,
        end_row_offset_idx: 1,
        start_col_offset_idx: col,
        end_col_offset_idx: col + 1,
        column_header: true,
      });
    });
  }
  const headerRowIdx = multiRowHeader ? 1 : 0;
  table.headerCells.forEach((text, col) => {
    cells.push({
      text,
      start_row_offset_idx: headerRowIdx,
      end_row_offset_idx: headerRowIdx + 1,
      start_col_offset_idx: col,
      end_col_offset_idx: col + 1,
      column_header: true,
    });
  });
  table.rows.forEach((row, r) => {
    row.forEach((text, col) => {
      cells.push({
        text,
        start_row_offset_idx: headerRowCount + r,
        end_row_offset_idx: headerRowCount + r + 1,
        start_col_offset_idx: col,
        end_col_offset_idx: col + 1,
        column_header: false,
      });
    });
  });

  const [x0, yTop, x1, yBottom] = table.bboxPt;
  return {
    prov: [{ page_no: table.page, bbox: bboxFor(x0, yTop, x1, yBottom, origin, pageHeight) }],
    data: { num_rows: headerRowCount + table.rows.length, num_cols: numCols, table_cells: cells },
  };
}

export function renderDoclingJson(pages: PageLayout[], opts: RenderDoclingJsonOptions = {}): unknown {
  const origin = opts.coordOrigin ?? "BOTTOMLEFT";
  const omitPageSize = opts.omitPageSize ?? false;
  const multiRowHeader = opts.multiRowHeader ?? false;

  const texts: unknown[] = [];
  const tables: unknown[] = [];
  const pagesOut: Record<string, unknown> = {};

  for (const page of pages) {
    pagesOut[String(page.page)] = omitPageSize
      ? { page_no: page.page }
      : { size: { width: page.widthPt, height: page.heightPt }, page_no: page.page };

    for (const line of groupOpsIntoLines(page.ops)) {
      const first = line[0]!;
      const text = line.map((op) => op.text).join(" ");
      const x0 = Math.min(...line.map((op) => op.x));
      const x1 = Math.max(...line.map((op) => op.x + opWidth(op)));
      const size = Math.max(...line.map((op) => op.size));
      const yTop = first.yTop;
      const bbox = bboxFor(x0, yTop, x1, yTop + size + LINE_PAD, origin, page.heightPt);
      texts.push({ label: doclingLabel(first.role), text, prov: [{ page_no: page.page, bbox }] });
    }

    for (const table of page.tables) {
      tables.push(buildTable(table, page.heightPt, origin, multiRowHeader));
    }
  }

  return { schema_name: "DoclingDocument", version: "1.0.0", texts, tables, pages: pagesOut };
}
