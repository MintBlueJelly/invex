import type {
  Bbox,
  ExtractedTable,
  PositionedLine,
  PositionedTextDocument,
  PositionedToken,
} from "../../src/positioned/model";

/**
 * Builders for hand-authored PositionedTextDocuments.
 *
 * Two test files grew their own near-identical copies of these; a third would
 * have made drift inevitable. Coordinates follow the model contract: bbox is
 * [x0, y0, x1, y1], each 0..1, origin TOP-LEFT, page 1-based.
 */

export interface LineOptions {
  page?: number;
  /** Vertical position of the line's top edge, 0..1. */
  y?: number;
  /** Left edge, 0..1. */
  x?: number;
  /** Line height, 0..1. */
  height?: number;
  /** Total width, 0..1. Tokens are laid out proportionally to their length. */
  width?: number;
  tag?: string;
}

/**
 * A line whose tokens are split on whitespace and spaced proportionally across
 * [x, x + width] — close enough to real text metrics for x-band logic, and
 * deterministic.
 */
export function line(text: string, opts: LineOptions = {}): PositionedLine {
  const page = opts.page ?? 1;
  const y = opts.y ?? 0.1;
  const x = opts.x ?? 0.05;
  const height = opts.height ?? 0.02;
  const width = opts.width ?? 0.9;
  const bbox: Bbox = [x, y, x + width, y + height];

  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const totalChars = words.reduce((n, w) => n + w.length, 0) || 1;
  const gap = words.length > 1 ? width * 0.02 : 0;
  const usable = width - gap * (words.length - 1);

  let cursor = x;
  const tokens: PositionedToken[] = words.map((w) => {
    const tw = (w.length / totalChars) * usable;
    const t: PositionedToken = { text: w, page, bbox: [cursor, y, cursor + tw, y + height] };
    cursor += tw + gap;
    return t;
  });

  return { text, page, bbox, tokens, ...(opts.tag ? { tag: opts.tag } : {}) };
}

/** A line whose tokens are placed at explicit x offsets — for column/band tests. */
export function columnLine(
  cells: { text: string; x: number; width?: number }[],
  opts: LineOptions = {},
): PositionedLine {
  const page = opts.page ?? 1;
  const y = opts.y ?? 0.1;
  const height = opts.height ?? 0.02;
  const tokens: PositionedToken[] = cells.map((c) => ({
    text: c.text,
    page,
    bbox: [c.x, y, c.x + (c.width ?? 0.08), y + height],
  }));
  const x0 = Math.min(...cells.map((c) => c.x));
  const x1 = Math.max(...cells.map((c) => c.x + (c.width ?? 0.08)));
  return {
    text: cells.map((c) => c.text).join(" "),
    page,
    bbox: [x0, y, x1, y + height],
    tokens,
    ...(opts.tag ? { tag: opts.tag } : {}),
  };
}

export function table(
  headerCells: string[],
  rows: string[][],
  opts: { page?: number; bbox?: Bbox } = {},
): ExtractedTable {
  return {
    page: opts.page ?? 1,
    bbox: opts.bbox ?? [0.05, 0.4, 0.95, 0.7],
    headerCells,
    rows,
  };
}

/** Stacks lines down the page automatically when they carry no explicit y. */
export function doc(
  lines: (PositionedLine | string)[],
  opts: { tables?: ExtractedTable[]; pageCount?: number; markdown?: string; startY?: number } = {},
): PositionedTextDocument {
  let y = opts.startY ?? 0.06;
  const built = lines.map((l) => {
    if (typeof l !== "string") return l;
    const made = line(l, { y });
    y += 0.03;
    return made;
  });
  return {
    pageCount: opts.pageCount ?? Math.max(1, ...built.map((l) => l.page)),
    lines: built,
    tables: opts.tables ?? [],
    ...(opts.markdown !== undefined ? { markdown: opts.markdown } : {}),
  };
}
