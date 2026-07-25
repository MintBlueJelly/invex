import type { CandidateLineItem } from "../schema/candidate";
import { parseAmount } from "../parsing/amounts";
import { mergeLines } from "../positioned/mergeLines";
import {
  normalizeLabel,
  type PositionedLine,
  type PositionedTextDocument,
} from "../positioned/model";
import { extractLineItemsFromTable } from "../table/lineItems";
import { applyTemplate, type TemplateApplication } from "./apply";
import type { VendorTemplate } from "./types";

/**
 * Template application on OCR output (briefing §2 Path C / §3): header fields
 * work through the normal anchor engine (normalized coordinates!), but OCR has
 * no TableFormer tables — line items are reconstructed by matching the header
 * signature in the merged text lines and deriving column x-bands from the
 * header tokens' positions.
 */
export function applyTemplateOcr(
  template: VendorTemplate,
  rawDoc: PositionedTextDocument,
): TemplateApplication {
  const doc = mergeLines(rawDoc);
  const base = applyTemplate(template, doc);

  const descriptor = template.lineItemTable;
  if (!descriptor) return base;

  const items = ocrLineItems(doc, template);
  if (items && items.length > 0) {
    base.envelope.invoice.lineItems = items;
    items.forEach((_, i) => {
      base.envelope.fieldMeta[`lineItems.${i}`] = { source: "ocr", confidence: 0.7 };
    });
    const missedIdx = base.fieldsMissed.indexOf("lineItems");
    if (missedIdx !== -1) base.fieldsMissed.splice(missedIdx, 1);
    if (!base.fieldsHit.includes("lineItems")) base.fieldsHit.push("lineItems");
  }
  return base;
}

const STOP_ROW = /zwischensumme|gesamtbetrag|rechnungsbetrag|endbetrag|summe|mwst|umsatzsteuer|total|amount\s+due/i;

function ocrLineItems(
  doc: PositionedTextDocument,
  template: VendorTemplate,
): CandidateLineItem[] | null {
  const descriptor = template.lineItemTable!;
  const signature = descriptor.headerSignature.map(normalizeLabel).filter((s) => s !== "");
  if (signature.length === 0) return null;

  // 1. Find the header line: ≥70% of signature cells present among its tokens.
  let header: PositionedLine | null = null;
  let headerBandStarts: (number | null)[] = [];
  for (const line of doc.lines) {
    const tokenNorms = line.tokens.map((t) => normalizeLabel(t.text));
    const starts = signature.map((sig) => {
      const idx = tokenNorms.findIndex((t) => t === sig || (sig.length >= 3 && t.includes(sig)));
      return idx === -1 ? null : line.tokens[idx]!.bbox[0];
    });
    const hits = starts.filter((s) => s !== null).length;
    if (hits / signature.length >= 0.7) {
      header = line;
      headerBandStarts = starts;
      break;
    }
  }
  if (!header) return null;

  // 2. Column x-bands in headerSignature order (template columns are indices
  //    into that order). Missing header tokens produce empty cells.
  const known = headerBandStarts
    .map((start, i) => ({ start, i }))
    .filter((b): b is { start: number; i: number } => b.start !== null)
    .sort((a, b) => a.start - b.start);
  // Column intervals: band k owns [start_k, start_{k+1}), with the outermost
  // edges left open so tokens outside the header span still land somewhere.
  const bounds = known.map((b, k) => ({
    i: b.i,
    lo: k === 0 ? Number.NEGATIVE_INFINITY : b.start,
    hi: k === known.length - 1 ? Number.POSITIVE_INFINITY : known[k + 1]!.start,
  }));

  /**
   * Assign a token by greatest horizontal OVERLAP with a column interval, not by
   * its left edge.
   *
   * Amount columns are right-aligned on essentially every invoice, so a value
   * wider than its header label starts to the left of that header. The previous
   * rule — "left edge within 0.02 of a header start" — pushed such a value into
   * the preceding column, and because that shifts every following token too, the
   * whole row moved one column across: the quantity cell ended up holding
   * "2 199,50" (which parseAmount happily fused into 2199.50) and the unit-price
   * cell held the line total (INVEX-002).
   *
   * Ties are broken to the RIGHT: a token straddling a boundary evenly is far
   * more likely to be a right-aligned number hanging back into the previous
   * column than left-aligned text spilling forward.
   */
  const bandFor = (x0: number, x1: number): number | null => {
    let best: { i: number; overlap: number } | null = null;
    for (const b of bounds) {
      const overlap = Math.min(x1, b.hi) - Math.max(x0, b.lo);
      if (overlap >= (best?.overlap ?? Number.EPSILON)) best = { i: b.i, overlap };
    }
    if (best) return best.i;
    // Zero-width or degenerate token: fall back to plain containment.
    const containing = bounds.filter((b) => x0 >= b.lo);
    return containing.length > 0 ? containing[containing.length - 1]!.i : null;
  };

  // 3. Data rows: merged lines below the header on the same page, until a
  //    totals-block line.
  const rows: string[][] = [];
  const candidates = doc.lines
    .filter((l) => l.page === header.page && l.bbox[1] > header.bbox[3] - 0.002)
    .sort((a, b) => a.bbox[1] - b.bbox[1]);
  for (const line of candidates) {
    if (STOP_ROW.test(line.text)) break;
    const cells = Array<string>(descriptor.headerSignature.length).fill("");
    let assigned = 0;
    for (const token of line.tokens) {
      const band = bandFor(token.bbox[0], token.bbox[2]);
      if (band === null) continue;
      cells[band] = cells[band] === "" ? token.text : `${cells[band]} ${token.text}`;
      assigned++;
    }
    if (assigned === 0) continue;
    rows.push(cells);
  }
  if (rows.length === 0) return null;

  return extractLineItemsFromTable(
    { page: header.page, bbox: header.bbox, headerCells: descriptor.headerSignature, rows },
    descriptor.columns,
    descriptor.descriptionContinuation,
    (s) => parseAmount(s, template.locale.decimal),
  );
}
