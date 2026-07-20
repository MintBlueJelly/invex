import type {
  Bbox,
  ExtractedTable,
  PositionedLine,
  PositionedTextDocument,
} from "../positioned/model";

/**
 * DoclingDocument JSON → PositionedTextDocument. This is the ONLY place that
 * knows Docling's shape; TableFormer output reaches the rule engine solely as
 * the normalized ExtractedTable.
 *
 * NOTE: written against the documented DoclingDocument schema and pinned by a
 * committed sample fixture. Capturing a live docling-serve response on a
 * Docker-capable machine remains an open verification step (plan risk #7).
 */

interface DoclingBbox {
  l: number;
  t: number;
  r: number;
  b: number;
  coord_origin?: string;
}

interface DoclingProv {
  page_no: number;
  bbox: DoclingBbox;
}

interface DoclingText {
  label?: string;
  text?: string;
  orig?: string;
  prov?: DoclingProv[];
}

interface DoclingTableCell {
  text?: string;
  start_row_offset_idx?: number;
  end_row_offset_idx?: number;
  start_col_offset_idx?: number;
  end_col_offset_idx?: number;
  column_header?: boolean;
}

interface DoclingTable {
  prov?: DoclingProv[];
  data?: {
    num_rows?: number;
    num_cols?: number;
    table_cells?: DoclingTableCell[];
  };
}

interface DoclingPage {
  size?: { width?: number; height?: number };
  page_no?: number;
}

interface DoclingDocumentJson {
  texts?: DoclingText[];
  tables?: DoclingTable[];
  pages?: Record<string, DoclingPage>;
}

function normBbox(bbox: DoclingBbox, page: DoclingPage | undefined): Bbox {
  const W = page?.size?.width ?? 1;
  const H = page?.size?.height ?? 1;
  const x0 = bbox.l / W;
  const x1 = bbox.r / W;
  let y0: number;
  let y1: number;
  if ((bbox.coord_origin ?? "TOPLEFT").toUpperCase() === "BOTTOMLEFT") {
    // BOTTOMLEFT: t/b measured up from the page bottom, t > b.
    y0 = (H - bbox.t) / H;
    y1 = (H - bbox.b) / H;
  } else {
    y0 = bbox.t / H;
    y1 = bbox.b / H;
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp(x0), clamp(Math.min(y0, y1)), clamp(x1), clamp(Math.max(y0, y1))];
}

export function mapDoclingDocument(json: unknown, markdown?: string): PositionedTextDocument {
  const doc = (json ?? {}) as DoclingDocumentJson;
  const pages = doc.pages ?? {};
  const pageCount = Math.max(1, ...Object.values(pages).map((p) => p.page_no ?? 0), 0);

  const lines: PositionedLine[] = [];
  for (const t of doc.texts ?? []) {
    const text = (t.text ?? t.orig ?? "").trim();
    const prov = t.prov?.[0];
    if (text === "" || !prov) continue;
    const page = prov.page_no;
    const bbox = normBbox(prov.bbox, pages[String(page)]);
    lines.push({
      text,
      page,
      bbox,
      tokens: [{ text, page, bbox }],
      ...(t.label ? { tag: t.label } : {}),
    });
  }
  lines.sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);

  const tables: ExtractedTable[] = [];
  for (const t of doc.tables ?? []) {
    const prov = t.prov?.[0];
    const data = t.data;
    if (!prov || !data?.table_cells) continue;
    const numRows = data.num_rows ?? 0;
    const numCols = data.num_cols ?? 0;
    if (numRows === 0 || numCols === 0) continue;

    const grid: string[][] = Array.from({ length: numRows }, () => Array<string>(numCols).fill(""));
    const headerRows = new Set<number>();
    for (const cell of data.table_cells) {
      const r0 = cell.start_row_offset_idx ?? 0;
      const r1 = cell.end_row_offset_idx ?? r0 + 1;
      const c0 = cell.start_col_offset_idx ?? 0;
      const c1 = cell.end_col_offset_idx ?? c0 + 1;
      const text = (cell.text ?? "").trim();
      for (let r = r0; r < Math.min(r1, numRows); r++) {
        for (let c = c0; c < Math.min(c1, numCols); c++) {
          grid[r]![c] = grid[r]![c] === "" ? text : `${grid[r]![c]} ${text}`.trim();
        }
      }
      if (cell.column_header) {
        for (let r = r0; r < Math.min(r1, numRows); r++) headerRows.add(r);
      }
    }

    // Multi-row headers merge per column; remaining rows are data.
    const headerIdx = [...headerRows].sort((a, b) => a - b);
    const headerCells =
      headerIdx.length > 0
        ? Array.from({ length: numCols }, (_, c) =>
            headerIdx.map((r) => grid[r]![c]).filter((v) => v !== "").join(" ").trim(),
          )
        : (grid[0] ?? []);
    const dataStart = headerIdx.length > 0 ? Math.max(...headerIdx) + 1 : 1;
    const rows = grid.slice(dataStart);

    tables.push({
      page: prov.page_no,
      bbox: normBbox(prov.bbox, pages[String(prov.page_no)]),
      headerCells,
      rows,
    });
  }

  return { pageCount, lines, tables, ...(markdown !== undefined ? { markdown } : {}) };
}
