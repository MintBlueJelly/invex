import type { LiteralInvoiceDoc } from "../literal/spec";

/**
 * The single source of geometry.
 *
 * A LiteralInvoiceDoc is laid out ONCE into positioned draw operations, and
 * every renderer — text PDF, scanned PDF, Docling JSON, OCR JSON — consumes the
 * result. Previously the text PDF and the hand-written Docling fixtures encoded
 * the same invoice twice, in two files, free to drift, with neither being truth.
 *
 * Coordinates are A4 POINTS with a TOP-LEFT origin, because that is how a human
 * reads a page. Renderers convert to whatever their target wants (pdf-lib is
 * bottom-left; Docling carries an explicit coord_origin).
 */

export type DrawRole =
  | "seller"
  | "buyer"
  | "heading"
  | "headerField"
  | "tableHeader"
  | "cell"
  | "total"
  | "note"
  | "footer"
  | "pageCounter";

export interface DrawOp {
  text: string;
  page: number;
  /** Left edge in points, top-left origin. */
  x: number;
  /** Top edge in points, top-left origin. */
  yTop: number;
  size: number;
  bold: boolean;
  role: DrawRole;
  /** Present for table cells and header cells; row -1 marks the header row. */
  cell?: { row: number; col: number };
}

export interface TableRegion {
  page: number;
  /** [x0, yTop, x1, yBottom] in points. */
  bboxPt: [number, number, number, number];
  headerCells: string[];
  rows: string[][];
}

export interface PageLayout {
  page: number;
  widthPt: number;
  heightPt: number;
  ops: DrawOp[];
  tables: TableRegion[];
}

export interface LayoutOptions {
  /** Left edge of each table column, in points. Length must match tableHeaders. */
  columnXPt?: number[];
  /** Right-align the numeric columns to the NEXT column's left edge minus a gap. */
  rightAlignAmounts?: boolean;
  /**
   * Push amount tokens further left of their own column header, in points.
   * Drives the INVEX-002 regression fixture: right-aligned values wider than
   * their header legitimately start left of it.
   */
  amountOverhangPt?: number;
  /** Break to a new page after this many line-item rows. */
  pageBreakAfterLine?: number;
  /** e.g. "Seite {n} von {total}" — printed at the foot of every page. */
  pageCounterFormat?: string;
}

const A4_W = 595.276;
const A4_H = 841.89;

const MARGIN = 50;
const BODY_SIZE = 10;
const HEADING_SIZE = 18;
const LINE_H = 14;
const ROW_H = 16;

const DEFAULT_COLUMNS = [50, 85, 330, 395, 480];

/** Rough advance width; only the geometry's RATIOS matter for our purposes. */
function textWidth(text: string, size: number, bold: boolean): number {
  return text.length * size * (bold ? 0.58 : 0.5);
}

export function layoutInvoice(doc: LiteralInvoiceDoc, opts: LayoutOptions = {}): PageLayout[] {
  const columnX = opts.columnXPt ?? DEFAULT_COLUMNS;
  if (columnX.length < doc.tableHeaders.length) {
    throw new Error(
      `layoutInvoice: ${doc.tableHeaders.length} table headers but only ${columnX.length} column positions`,
    );
  }
  const overhang = opts.amountOverhangPt ?? 0;
  const rightEdgeOf = (col: number): number =>
    (col + 1 < columnX.length ? columnX[col + 1]! : A4_W - MARGIN) - 8;

  /** Money and quantity columns are the ones a real invoice right-aligns. */
  const AMOUNT_ROLES = new Set(["quantity", "unitPrice", "taxRate", "lineTotal"]);
  const isAmountColumn = (col: number): boolean => AMOUNT_ROLES.has(doc.tableColumns[col] ?? "");

  const pages: PageLayout[] = [];
  let ops: DrawOp[] = [];
  let tables: TableRegion[] = [];
  let page = 1;
  let y = MARGIN;

  const push = (
    text: string,
    x: number,
    size: number,
    bold: boolean,
    role: DrawRole,
    cell?: { row: number; col: number },
  ) => {
    ops.push({ text, page, x, yTop: y, size, bold, role, ...(cell ? { cell } : {}) });
  };

  const newPage = () => {
    pages.push({ page, widthPt: A4_W, heightPt: A4_H, ops, tables });
    ops = [];
    tables = [];
    page += 1;
    y = MARGIN;
  };

  // ── letterhead ────────────────────────────────────────────────────────────
  push(doc.seller.nameText, MARGIN, BODY_SIZE + 1, true, "seller");
  y += LINE_H;
  for (const l of doc.seller.addressLines) {
    push(l, MARGIN, BODY_SIZE, false, "seller");
    y += LINE_H;
  }
  for (const l of [doc.seller.taxIdLine, doc.seller.steuernummerLine]) {
    if (!l) continue;
    push(l, MARGIN, BODY_SIZE, false, "seller");
    y += LINE_H;
  }

  // ── heading + header fields ───────────────────────────────────────────────
  y += LINE_H * 2;
  const headingY = y;
  push(doc.headingText, MARGIN, HEADING_SIZE, true, "heading");

  // Header fields sit top-right, aligned with the heading.
  let fieldY = headingY;
  for (const f of doc.headerFields) {
    ops.push({ text: f.labelText, page, x: 330, yTop: fieldY, size: BODY_SIZE, bold: false, role: "headerField" });
    ops.push({ text: f.valueText, page, x: 460, yTop: fieldY, size: BODY_SIZE, bold: false, role: "headerField" });
    fieldY += LINE_H;
  }
  y = Math.max(headingY + HEADING_SIZE + LINE_H, fieldY) + LINE_H;

  // ── buyer ─────────────────────────────────────────────────────────────────
  for (const l of doc.buyerLines ?? []) {
    push(l, MARGIN, BODY_SIZE, false, "buyer");
    y += LINE_H;
  }
  y += LINE_H;

  // ── line-item table ───────────────────────────────────────────────────────
  const emitTableHeader = (): number => {
    const top = y;
    doc.tableHeaders.forEach((h, col) => {
      push(h, columnX[col]!, BODY_SIZE, true, "tableHeader", { row: -1, col });
    });
    y += ROW_H;
    return top;
  };

  let tableTop = doc.tableHeaders.length > 0 ? emitTableHeader() : y;
  let rows: string[][] = [];
  let rendered = 0;

  const cellsOf = (l: import("../literal/spec").LiteralLine): string[] =>
    doc.tableColumns.map((role) => {
      switch (role) {
        case "position":
          return l.posText ?? "";
        case "description":
          return l.descriptionText;
        case "quantity":
          return l.quantityText ?? "";
        case "unit":
          return l.unitText ?? "";
        case "unitPrice":
          return l.unitPriceText ?? "";
        case "taxRate":
          return l.taxRateText ?? "";
        case "lineTotal":
          return l.lineTotalText ?? "";
      }
    });

  const closeTable = () => {
    // A letter has no table; emitting an empty one would hand the classifier and
    // the rule engine a phantom structure that is not on the page.
    if (doc.tableHeaders.length === 0) return;
    tables.push({
      page,
      bboxPt: [columnX[0]!, tableTop, A4_W - MARGIN, y],
      headerCells: doc.tableHeaders,
      rows,
    });
    rows = [];
  };

  for (const l of doc.lines) {
    const cells = cellsOf(l).slice(0, doc.tableHeaders.length);
    cells.forEach((text, col) => {
      if (text === "") return;
      let x = columnX[col]!;
      if (opts.rightAlignAmounts !== false && isAmountColumn(col)) {
        x = rightEdgeOf(col) - textWidth(text, BODY_SIZE, false) - (isAmountColumn(col) ? overhang : 0);
      }
      push(text, x, BODY_SIZE, false, "cell", { row: rows.length, col });
    });
    rows.push(cells);
    y += ROW_H;
    rendered += 1;

    if (l.continuationText) {
      // A wrapped description: same table, no position number. This is the
      // continuation case the briefing calls the most common line-item failure.
      const descCol = Math.max(0, doc.tableColumns.indexOf("description"));
      const contCells = cells.map((_, col) => (col === descCol ? l.continuationText! : ""));
      push(l.continuationText, columnX[descCol]!, BODY_SIZE, false, "cell", { row: rows.length, col: descCol });
      rows.push(contCells);
      y += ROW_H;
    }

    if (opts.pageBreakAfterLine && rendered % opts.pageBreakAfterLine === 0 && rendered < doc.lines.length) {
      closeTable();
      newPage();
      tableTop = emitTableHeader();
      rows = [];
    }
  }
  closeTable();

  // ── totals block ──────────────────────────────────────────────────────────
  y += LINE_H;
  for (const t of doc.totalsBlock) {
    push(t.labelText, 330, BODY_SIZE, t.bold ?? false, "total");
    const valueX = A4_W - MARGIN - textWidth(t.valueText, BODY_SIZE, t.bold ?? false);
    ops.push({
      text: t.valueText,
      page,
      x: valueX,
      yTop: y,
      size: BODY_SIZE,
      bold: t.bold ?? false,
      role: "total",
    });
    y += LINE_H;
  }

  // ── notes & footer ────────────────────────────────────────────────────────
  y += LINE_H;
  for (const l of doc.noteLines ?? []) {
    push(l, MARGIN, BODY_SIZE, false, "note");
    y += LINE_H;
  }
  for (const l of doc.seller.bankLines ?? []) {
    push(l, MARGIN, BODY_SIZE, false, "footer");
    y += LINE_H;
  }
  for (const l of doc.footerLines ?? []) {
    push(l, MARGIN, BODY_SIZE, false, "footer");
    y += LINE_H;
  }

  pages.push({ page, widthPt: A4_W, heightPt: A4_H, ops, tables });

  if (opts.pageCounterFormat) {
    const total = pages.length;
    for (const p of pages) {
      p.ops.push({
        text: opts.pageCounterFormat.replace("{n}", String(p.page)).replace("{total}", String(total)),
        page: p.page,
        x: MARGIN,
        yTop: A4_H - MARGIN,
        size: 8,
        bold: false,
        role: "pageCounter",
      });
    }
  }

  return pages;
}

/** Width of a laid-out op, for renderers that need a bounding box. */
export function opWidth(op: DrawOp): number {
  return textWidth(op.text, op.size, op.bold);
}
