import type { CandidateInvoice, ExtractionEnvelope, FieldMeta } from "../schema/candidate";
import { parseAmount } from "../parsing/amounts";
import { parseDateToIso } from "../parsing/dates";
import {
  normalizeLabel,
  type ExtractedTable,
  type PositionedLine,
  type PositionedTextDocument,
} from "../positioned/model";
import { extractLineItemsFromTable } from "../table/lineItems";
import type { LineColumnKey } from "../template/types";
import { defaultLexicon, type Lexicon } from "./lexicon";

/**
 * Generic rule engine (briefing §3): the template-less first attempt for
 * first-seen vendors with a text layer. Label-anchor matching against the
 * synonym lexicon, locale-aware parsing, table-column classification by header
 * synonyms on TableFormer output.
 */

export interface RuleEngineResult {
  envelope: ExtractionEnvelope;
  fieldsFound: string[];
  /** Lexicon fields with no usable anchor — feeds escalation logging (§8). */
  fieldsMissed: string[];
}

type HeaderKey = keyof Lexicon["header"];

interface LabelHit {
  line: PositionedLine;
  remainder: string;
  labelLength: number;
}

/**
 * All lines starting with any of the labels, most-specific (longest) label
 * first — "Zwischensumme (netto)" outranks "Netto"; a hit that yields no
 * parseable value falls through to the next ("USt-IdNr." must not satisfy
 * the "USt" tax label).
 */
function findLabelHits(doc: PositionedTextDocument, labels: string[]): LabelHit[] {
  const hits: LabelHit[] = [];
  for (const label of labels) {
    const normLabel = normalizeLabel(label);
    if (normLabel === "") continue;
    for (const line of doc.lines) {
      const norm = normalizeLabel(line.text);
      if (!norm.startsWith(normLabel)) continue;
      const end = approximateEnd(line.text, normLabel);
      if (end === null) continue;
      const remainder = line.text.slice(end).replace(/^[.:\s]+/, "");
      hits.push({ line, remainder, labelLength: normLabel.length });
    }
  }
  return hits.sort((a, b) => b.labelLength - a.labelLength);
}

/** Amount fields: remainder must LEAD with a number, and the value is the LAST
 *  amount on the line ("MwSt. 19%: 218,25" → 218,25, not the rate). */
function extractAmountValue(remainder: string): { raw: string; value: string } | null {
  if (!/^[€$£]?\s*-?\d/.test(remainder)) return null;
  const matches = [...remainder.matchAll(/-?[\d.,]+/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const value = parseAmount(last[0]);
  return value === null ? null : { raw: last[0], value };
}

/** Index into the ORIGINAL text where the normalized prefix ends. */
function approximateEnd(text: string, normTarget: string): number | null {
  let acc = "";
  for (let i = 0; i < text.length; i++) {
    acc += normalizeLabel(text[i]!);
    if (acc.length >= normTarget.length) {
      return acc.startsWith(normTarget) ? i + 1 : null;
    }
  }
  return null;
}

function classifyColumns(
  table: ExtractedTable,
  lexicon: Lexicon,
): Partial<Record<LineColumnKey, number>> | null {
  const columns: Partial<Record<LineColumnKey, number>> = {};
  const used = new Set<number>();
  const keys: LineColumnKey[] = ["description", "lineTotal", "unitPrice", "quantity", "position", "taxRate", "unit"];
  for (const key of keys) {
    const synonyms = lexicon.table[key].map(normalizeLabel);
    for (let c = 0; c < table.headerCells.length; c++) {
      if (used.has(c)) continue;
      const header = normalizeLabel(table.headerCells[c] ?? "");
      if (header === "") continue;
      if (synonyms.some((s) => header === s || (s.length >= 3 && header.includes(s)))) {
        columns[key] = c;
        used.add(c);
        break;
      }
    }
  }
  if (columns.description === undefined) return null;
  if (columns.lineTotal === undefined && columns.unitPrice === undefined) return null;
  return columns;
}

export function runRuleEngine(
  doc: PositionedTextDocument,
  lexicon: Lexicon = defaultLexicon,
): RuleEngineResult {
  const invoice: CandidateInvoice = {};
  const fieldMeta: Record<string, FieldMeta> = {};
  const fieldsFound: string[] = [];
  const fieldsMissed: string[] = [];

  const setMeta = (path: string, hit: LabelHit, raw: string) => {
    fieldMeta[path] = {
      source: "rules",
      confidence: 0.65,
      rawText: raw,
      anchor: { page: hit.line.page, bbox: hit.line.bbox },
    };
  };

  for (const [key, entry] of Object.entries(lexicon.header) as [HeaderKey, Lexicon["header"][HeaderKey]][]) {
    let found = false;
    for (const hit of findLabelHits(doc, entry.labels)) {
      let value: string | null = null;
      let raw = "";
      if (key.startsWith("totals.")) {
        const amount = extractAmountValue(hit.remainder);
        if (amount) ({ raw, value } = amount);
      } else {
        raw = hit.remainder;
        if (entry.valuePattern) {
          const m = new RegExp(entry.valuePattern).exec(hit.remainder);
          raw = m ? m[0] : "";
        }
        if (raw !== "") {
          value = key === "issueDate" || key === "dueDate" ? parseDateToIso(raw) : raw.trim();
        }
      }
      if (value !== null) {
        setHeaderField(invoice, key, value);
        setMeta(key, hit, raw);
        fieldsFound.push(key);
        found = true;
        break;
      }
    }
    if (!found) fieldsMissed.push(key);
  }

  // VAT breakdown lines: "MwSt. 19%: 218,25" → { rate, tax } (net solver-derived).
  const vatEntries: { rate: number; tax: string }[] = [];
  for (const line of doc.lines) {
    const m = /(mwst|mehrwertsteuer|ust|umsatzsteuer|vat|tax)[^%\d]{0,20}(\d{1,2})\s?%\s*:?\s*(-?[\d.,]+)/i.exec(line.text);
    if (!m) continue;
    const tax = parseAmount(m[3]!);
    if (tax === null) continue;
    const rate = Number(m[2]);
    if (!vatEntries.some((v) => v.rate === rate)) vatEntries.push({ rate, tax });
  }
  if (vatEntries.length > 0) {
    invoice.vatBreakdown = vatEntries.map((v) => ({ rate: v.rate, tax: v.tax, net: null }));
    fieldsFound.push("vatBreakdown");
    invoice.vatBreakdown.forEach((_, i) => {
      fieldMeta[`vatBreakdown.${i}`] = { source: "rules", confidence: 0.6 };
    });
  }

  // Line items: best column-classifiable table.
  let lineItemsFound = false;
  for (const table of doc.tables) {
    const columns = classifyColumns(table, lexicon);
    if (!columns) continue;
    const items = extractLineItemsFromTable(
      table,
      columns,
      columns.position !== undefined ? "rowsWithoutPosNumber" : "none",
      (s) => parseAmount(s),
    );
    if (items.length === 0) continue;
    invoice.lineItems = items;
    items.forEach((_, i) => {
      fieldMeta[`lineItems.${i}`] = { source: "rules", confidence: 0.6 };
    });
    fieldsFound.push("lineItems");
    lineItemsFound = true;
    break;
  }
  if (!lineItemsFound) fieldsMissed.push("lineItems");

  // Currency: explicit ISO code or symbol.
  const allText = doc.lines.map((l) => l.text).join(" ");
  if (/\bEUR\b|€/.test(allText)) invoice.currency = "EUR";
  else if (/\bUSD\b|\$/.test(allText)) invoice.currency = "USD";
  else if (/\bGBP\b|£/.test(allText)) invoice.currency = "GBP";

  return { envelope: { invoice, fieldMeta }, fieldsFound, fieldsMissed };
}

function setHeaderField(invoice: CandidateInvoice, key: HeaderKey, value: string): void {
  switch (key) {
    case "invoiceNumber":
      invoice.invoiceNumber = value;
      break;
    case "issueDate":
      invoice.issueDate = value;
      break;
    case "dueDate":
      invoice.dueDate = value;
      break;
    case "totals.net":
      invoice.totals = { ...invoice.totals, net: value };
      break;
    case "totals.tax":
      invoice.totals = { ...invoice.totals, tax: value };
      break;
    case "totals.gross":
      invoice.totals = { ...invoice.totals, gross: value };
      break;
  }
}
