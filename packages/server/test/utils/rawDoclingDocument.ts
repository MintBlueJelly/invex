/**
 * Generic, position-based DoclingDocument JSON builder for test scenarios that
 * have no golden equivalent at all — garbage text layers, partial/uncertain
 * classification signals, multi-invoice segmentation — because they are not
 * realistic invoices an oracle would model, but deliberately synthetic pipeline
 * edge cases. Kept separate from the goldens/layout seam on purpose: forcing
 * these through `layoutInvoice`'s seller/heading/table slots would distort the
 * exact shape each of these edge cases needs to test.
 *
 * Coordinates are A4 points with a BOTTOMLEFT origin, matching what
 * docling-serve actually emits (same convention the deleted doclingFixtures.ts
 * used), so the mapper's y-flip is genuinely exercised.
 */

const W = 595;
const H = 842;

export interface SpecLine {
  text: string;
  x: number;
  /** y measured from the TOP of the page (points). */
  yTop: number;
  label?: string;
  page?: number;
  w?: number;
}

export interface SpecTable {
  headers: string[];
  rows: string[][];
  yTop?: number;
  page?: number;
}

export function rawDoclingDocument(lines: SpecLine[], tables: SpecTable[] = [], pageCount = 1): unknown {
  const pages: Record<string, unknown> = {};
  for (let p = 1; p <= pageCount; p++) {
    pages[String(p)] = { size: { width: W, height: H }, page_no: p };
  }
  return {
    schema_name: "DoclingDocument",
    version: "1.0.0",
    texts: lines.map((l) => ({
      label: l.label ?? "text",
      text: l.text,
      prov: [
        {
          page_no: l.page ?? 1,
          bbox: {
            l: l.x,
            r: l.x + (l.w ?? Math.min(420, l.text.length * 5.5)),
            t: H - l.yTop,
            b: H - (l.yTop + 12),
            coord_origin: "BOTTOMLEFT",
          },
        },
      ],
    })),
    tables: tables.map((tb) => {
      const yTop = tb.yTop ?? 300;
      const numCols = tb.headers.length;
      const numRows = tb.rows.length + 1;
      const cells = [
        ...tb.headers.map((text, c) => ({
          text,
          start_row_offset_idx: 0,
          end_row_offset_idx: 1,
          start_col_offset_idx: c,
          end_col_offset_idx: c + 1,
          column_header: true,
        })),
        ...tb.rows.flatMap((row, r) =>
          row.map((text, c) => ({
            text,
            start_row_offset_idx: r + 1,
            end_row_offset_idx: r + 2,
            start_col_offset_idx: c,
            end_col_offset_idx: c + 1,
            column_header: false,
          })),
        ),
      ];
      return {
        prov: [
          {
            page_no: tb.page ?? 1,
            bbox: { l: 50, r: 545, t: H - yTop, b: H - (yTop + 30 + tb.rows.length * 16), coord_origin: "BOTTOMLEFT" },
          },
        ],
        data: { num_rows: numRows, num_cols: numCols, table_cells: cells },
      };
    }),
    pages,
  };
}
