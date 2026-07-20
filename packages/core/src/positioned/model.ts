/**
 * The single positioned-text representation that templates, the rule engine,
 * and the classifier consume. Produced by BOTH the Docling mapper (Path B) and
 * the OCR mapper (Path C) — normalized page-relative coordinates are why one
 * template works on either lane (briefing §3).
 *
 * Coordinates: bbox = [x0, y0, x1, y1], each 0..1, origin TOP-LEFT; page 1-based.
 */

export type Bbox = [number, number, number, number];

export interface PositionedToken {
  text: string;
  page: number;
  bbox: Bbox;
}

export interface PositionedLine {
  text: string;
  page: number;
  bbox: Bbox;
  tokens: PositionedToken[];
  /** Docling layout label where available ("section_header", "title", ...). */
  tag?: string;
}

export interface ExtractedTable {
  page: number;
  bbox: Bbox;
  headerCells: string[];
  rows: string[][];
}

export interface PositionedTextDocument {
  pageCount: number;
  lines: PositionedLine[];
  tables: ExtractedTable[];
  markdown?: string;
}

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export function inflate(b: Bbox, by: number): Bbox {
  return [
    Math.max(0, b[0] - by),
    Math.max(0, b[1] - by),
    Math.min(1, b[2] + by),
    Math.min(1, b[3] + by),
  ];
}

/** Case/diacritic/punctuation-insensitive comparison key for labels/headers. */
export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%]/g, "");
}
