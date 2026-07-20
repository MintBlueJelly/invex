import type { CanonicalInvoice } from "../schema/invoice";
import { renderAmount, type DecimalSeparator } from "../parsing/amounts";
import { renderIsoDate } from "../parsing/dates";
import {
  normalizeLabel,
  type ExtractedTable,
  type PositionedLine,
  type PositionedTextDocument,
} from "../positioned/model";
import { mergeLines } from "../positioned/mergeLines";
import { defaultLexicon } from "../rules/lexicon";
import {
  isPlausibleSteuernummer,
  isValidIban,
  isValidUstIdNr,
  normalizeIban,
  vendorNameHash,
} from "../vendor/checksums";
import type {
  FieldDescriptor,
  LineColumnKey,
  LineItemTableDescriptor,
  TemplateFieldKey,
  VendorTemplate,
} from "./types";

/**
 * Template induction (briefing §3/§6/§7): given a FINAL, reconciled invoice and
 * the positioned text it came from, locate each value on the page and record
 * positional anchors + labels + generalized value patterns. Escalations are
 * template-generation events — this is the feedback loop that grows
 * deterministic coverage.
 *
 * Fields that cannot be located are simply omitted; partial templates are fine.
 */

const DATE_FORMAT_CANDIDATES = ["dd.MM.yyyy", "d.M.yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "dd.MM.yy"];

interface ValueHit {
  line: PositionedLine;
  start: number;
  matched: string;
}

/** Find a line whose text contains one of the rendered variants of a value. */
function findValue(doc: PositionedTextDocument, variants: string[]): ValueHit | null {
  for (const line of doc.lines) {
    for (const v of variants) {
      if (v === "") continue;
      const idx = line.text.indexOf(v);
      if (idx !== -1) return { line, start: idx, matched: v };
    }
  }
  return null;
}

function amountVariants(dotDecimal: string, decimal: DecimalSeparator): string[] {
  return [
    renderAmount(dotDecimal, decimal, true),
    renderAmount(dotDecimal, decimal, false),
    dotDecimal,
  ];
}

/** Digit runs → \d+, everything else escaped: "R-2026-0042" → "R-\d+-\d+". */
function generalizePattern(raw: string): string {
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(/\d+/g, "\\d+");
}

function labelBefore(hit: ValueHit): string | undefined {
  const before = hit.line.text.slice(0, hit.start).replace(/[:\s]+$/, "").trim();
  if (before.length >= 2 && before.length <= 60) return before;
  return undefined;
}

function descriptorFor(
  hit: ValueHit,
  doc: PositionedTextDocument,
  valuePattern: string | undefined,
): FieldDescriptor {
  const page = doc.pageCount > 1 && hit.line.page === doc.pageCount ? -1 : hit.line.page;
  const d: FieldDescriptor = {
    region: { page, bbox: hit.line.bbox },
  };
  const label = labelBefore(hit);
  if (label) d.label = label;
  if (valuePattern) d.valuePattern = valuePattern;
  return d;
}

function detectLocale(invoice: CanonicalInvoice, doc: PositionedTextDocument): {
  decimal: DecimalSeparator;
  dateFormats: string[];
} {
  let decimal: DecimalSeparator = ",";
  const gross = invoice.totals.gross;
  if (findValue(doc, amountVariants(gross, ","))) decimal = ",";
  else if (findValue(doc, amountVariants(gross, "."))) decimal = ".";

  const dateFormats: string[] = [];
  for (const fmt of DATE_FORMAT_CANDIDATES) {
    const rendered = renderIsoDate(invoice.issueDate, fmt);
    if (rendered && findValue(doc, [rendered])) dateFormats.push(fmt);
  }
  if (dateFormats.length === 0) dateFormats.push("dd.MM.yyyy", "yyyy-MM-dd");
  return { decimal, dateFormats };
}

const AMOUNT_PATTERN = "-?[\\d.,]+";

function induceHeaderFields(
  invoice: CanonicalInvoice,
  doc: PositionedTextDocument,
  locale: { decimal: DecimalSeparator; dateFormats: string[] },
): Partial<Record<TemplateFieldKey, FieldDescriptor>> {
  const fields: Partial<Record<TemplateFieldKey, FieldDescriptor>> = {};

  const invNum = findValue(doc, [invoice.invoiceNumber]);
  if (invNum) {
    fields["invoiceNumber"] = descriptorFor(invNum, doc, generalizePattern(invoice.invoiceNumber));
  }

  const dateField = (key: "issueDate" | "dueDate", iso: string | null) => {
    if (!iso) return;
    for (const fmt of locale.dateFormats) {
      const rendered = renderIsoDate(iso, fmt);
      if (!rendered) continue;
      const hit = findValue(doc, [rendered]);
      if (hit) {
        fields[key] = descriptorFor(hit, doc, generalizePattern(rendered));
        return;
      }
    }
  };
  dateField("issueDate", invoice.issueDate);
  dateField("dueDate", invoice.dueDate);

  const amountField = (key: TemplateFieldKey, value: string) => {
    const hit = findValue(doc, amountVariants(value, locale.decimal));
    if (hit) fields[key] = descriptorFor(hit, doc, AMOUNT_PATTERN);
  };
  amountField("totals.gross", invoice.totals.gross);
  amountField("totals.net", invoice.totals.net);
  amountField("totals.tax", invoice.totals.tax);

  return fields;
}

/** Numeric-string equality after normalization ("2" == "2.00"). */
function numEq(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const norm = (s: string) => {
    let t = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
    t = t.replace(/^(-?)0+(?=\d)/, "$1");
    return t;
  };
  return norm(a) === norm(b);
}

function induceLineItemTable(
  invoice: CanonicalInvoice,
  doc: PositionedTextDocument,
  decimal: DecimalSeparator,
): LineItemTableDescriptor | undefined {
  // Find the table containing the most line descriptions (prefix match).
  const descKeys = invoice.lineItems.map((l) => normalizeLabel(l.description).slice(0, 20));
  let best: { table: ExtractedTable; hits: number } | null = null;
  for (const table of doc.tables) {
    let hits = 0;
    for (const key of descKeys) {
      if (key === "") continue;
      if (table.rows.some((row) => row.some((cell) => normalizeLabel(cell).startsWith(key)))) hits++;
    }
    if (hits > 0 && (best === null || hits > best.hits)) best = { table, hits };
  }
  if (!best) return undefined;
  const table = best.table;
  const columnCount = Math.max(table.headerCells.length, ...table.rows.map((r) => r.length));

  // Vote on column meanings using the known line values.
  const votes = new Map<LineColumnKey, Map<number, number>>();
  const vote = (key: LineColumnKey, col: number) => {
    const m = votes.get(key) ?? new Map<number, number>();
    m.set(col, (m.get(col) ?? 0) + 1);
    votes.set(key, m);
  };

  for (const item of invoice.lineItems) {
    const descKey = normalizeLabel(item.description).slice(0, 20);
    const row = table.rows.find((r) => r.some((c) => normalizeLabel(c).startsWith(descKey)));
    if (!row) continue;
    for (let col = 0; col < columnCount; col++) {
      const cell = row[col]?.trim() ?? "";
      if (cell === "") continue;
      if (normalizeLabel(cell).startsWith(descKey)) vote("description", col);
      if (item.position !== null && cell === String(item.position)) vote("position", col);
      const cellDot = cellToDot(cell, decimal);
      if (numEq(cellDot, item.quantity)) vote("quantity", col);
      if (numEq(cellDot, item.unitPrice)) vote("unitPrice", col);
      if (numEq(cellDot, item.lineTotal)) vote("lineTotal", col);
      if (item.taxRate !== null && /%/.test(cell) && numEq(cellToDot(cell.replace("%", ""), decimal), String(item.taxRate))) {
        vote("taxRate", col);
      }
      if (item.unit !== null && cell === item.unit) vote("unit", col);
    }
  }

  // Greedy assignment, most-critical keys first, no index reuse.
  const columns: Partial<Record<LineColumnKey, number>> = {};
  const used = new Set<number>();
  const order: LineColumnKey[] = ["description", "lineTotal", "unitPrice", "quantity", "position", "taxRate", "unit"];
  for (const key of order) {
    const m = votes.get(key);
    if (!m) continue;
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const winner = ranked.find(([col]) => !used.has(col));
    if (winner) {
      columns[key] = winner[0];
      used.add(winner[0]);
    }
  }
  if (columns.description === undefined) return undefined;

  const posCol = columns.position;
  const hasContinuationRows =
    posCol !== undefined &&
    table.rows.some((r) => {
      const pos = r[posCol]?.trim() ?? "";
      const desc = r[columns.description!]?.trim() ?? "";
      return !/^\d+$/.test(pos) && desc !== "";
    });

  return {
    headerSignature: table.headerCells,
    columns,
    descriptionContinuation: hasContinuationRows ? "rowsWithoutPosNumber" : "none",
  };
}

function cellToDot(cell: string, decimal: DecimalSeparator): string | null {
  const cleaned = cell.replace(/(EUR|€)/gi, "").trim();
  if (!/^-?[\d.,]+$/.test(cleaned)) return null;
  // Reuse the locale-pinned interpretation.
  const sep = decimal;
  const pos = cleaned.lastIndexOf(sep);
  if (pos === -1) return cleaned.replace(/[.,]/g, "");
  const frac = cleaned.slice(pos + 1);
  if (!/^\d{1,4}$/.test(frac)) return cleaned.replace(/[.,]/g, "");
  return `${cleaned.slice(0, pos).replace(/[.,]/g, "") || "0"}.${frac}`;
}

/**
 * OCR documents have no TableFormer tables: recover the line-item table from
 * the merged text lines instead — the header row is the line whose tokens map
 * to ≥3 distinct column synonyms from the lexicon. Without this, templates
 * induced on Path C could never extract line items and scanned vendors would
 * escalate forever, defeating the feedback loop.
 */
function induceOcrLineItemTable(doc: PositionedTextDocument): LineItemTableDescriptor | undefined {
  const merged = mergeLines(doc);
  const columnKeys = Object.keys(defaultLexicon.table) as (keyof typeof defaultLexicon.table)[];
  for (const line of merged.lines) {
    if (line.tokens.length < 3) continue;
    const columns: Partial<Record<(typeof columnKeys)[number], number>> = {};
    const usedTokens = new Set<number>();
    for (const key of columnKeys) {
      const synonyms = defaultLexicon.table[key].map(normalizeLabel);
      for (let i = 0; i < line.tokens.length; i++) {
        if (usedTokens.has(i)) continue;
        const norm = normalizeLabel(line.tokens[i]!.text);
        if (norm !== "" && synonyms.some((s) => norm === s || (s.length >= 3 && norm.includes(s)))) {
          columns[key] = i;
          usedTokens.add(i);
          break;
        }
      }
    }
    const mapped = Object.keys(columns).length;
    if (mapped >= 3 && columns.description !== undefined && (columns.lineTotal !== undefined || columns.unitPrice !== undefined)) {
      return {
        headerSignature: line.tokens.map((t) => t.text),
        columns,
        descriptionContinuation: columns.position !== undefined ? "rowsWithoutPosNumber" : "none",
      };
    }
  }
  return undefined;
}

export function induceTemplate(
  invoice: CanonicalInvoice,
  doc: PositionedTextDocument,
): VendorTemplate {
  const locale = detectLocale(invoice, doc);
  const fields = induceHeaderFields(invoice, doc, locale);
  const lineItemTable =
    doc.tables.length > 0
      ? induceLineItemTable(invoice, doc, locale.decimal)
      : induceOcrLineItemTable(doc);

  const seller = invoice.seller;
  const vendorIds: VendorTemplate["vendorIds"] = {
    displayName: seller.name,
    nameHash: vendorNameHash(seller.name, seller.address?.postalCode ?? null),
  };
  if (seller.ustIdNr && isValidUstIdNr(seller.ustIdNr)) vendorIds.ustIdNr = seller.ustIdNr.replace(/\s+/g, "").toUpperCase();
  if (seller.steuernummer && isPlausibleSteuernummer(seller.steuernummer)) vendorIds.steuernummer = seller.steuernummer;
  const ibans = seller.ibans.map(normalizeIban).filter(isValidIban);
  if (ibans.length > 0) vendorIds.ibans = ibans;

  return {
    templateVersion: 1,
    vendorIds,
    locale,
    fields,
    ...(lineItemTable ? { lineItemTable } : {}),
  };
}

/** A template is worth persisting when it can actually extract something. */
export function templateIsUseful(t: VendorTemplate): boolean {
  return Object.keys(t.fields).length >= 2 || t.lineItemTable !== undefined;
}
