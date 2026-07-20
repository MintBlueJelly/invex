import type { CandidateLineItem } from "../schema/candidate";
import type { ExtractedTable } from "../positioned/model";
import type { LineColumnKey } from "../template/types";

/**
 * Shared line-item extraction over a matched table: index-based column mapping
 * plus multi-row description continuation (the most common line-item failure
 * mode, briefing §3). Used by BOTH template application (locale-pinned parsing)
 * and the generic rule engine (auto-detected locale).
 */
export function extractLineItemsFromTable(
  table: ExtractedTable,
  columns: Partial<Record<LineColumnKey, number>>,
  continuation: "rowsWithoutPosNumber" | "indentedRows" | "none",
  parseNum: (s: string) => string | null,
): CandidateLineItem[] {
  const cell = (row: string[], key: LineColumnKey): string | null => {
    const idx = columns[key];
    if (idx === undefined) return null;
    const v = row[idx];
    return v === undefined || v.trim() === "" ? null : v.trim();
  };

  const items: CandidateLineItem[] = [];
  for (const row of table.rows) {
    const description = cell(row, "description");
    const posText = cell(row, "position");
    const posNumeric = posText !== null && /^\d+$/.test(posText);
    const qty = cell(row, "quantity");
    const unitPrice = cell(row, "unitPrice");
    const lineTotal = cell(row, "lineTotal");

    const isContinuation =
      continuation === "rowsWithoutPosNumber" &&
      columns.position !== undefined &&
      !posNumeric &&
      description !== null &&
      qty === null &&
      unitPrice === null &&
      lineTotal === null;

    if (isContinuation && items.length > 0) {
      const prev = items[items.length - 1]!;
      prev.description = `${prev.description} ${description}`.trim();
      continue;
    }
    if (description === null) continue;

    const taxText = cell(row, "taxRate");
    const taxParsed = taxText !== null ? parseNum(taxText.replace("%", "")) : null;
    items.push({
      position: posNumeric ? Number(posText) : null,
      description,
      quantity: qty !== null ? parseNum(qty) : null,
      unit: cell(row, "unit"),
      unitPrice: unitPrice !== null ? parseNum(unitPrice) : null,
      taxRate: taxParsed !== null ? Number(taxParsed) : null,
      lineTotal: lineTotal !== null ? parseNum(lineTotal) : null,
    });
  }
  return items;
}
