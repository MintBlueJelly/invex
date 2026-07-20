import type {
  CandidateInvoice,
  CandidateLineItem,
  ExtractionEnvelope,
  FieldMeta,
} from "../schema/candidate";
import { parseAmount } from "../parsing/amounts";
import { parseDateToIso } from "../parsing/dates";
import {
  bboxIntersects,
  inflate,
  normalizeLabel,
  type ExtractedTable,
  type PositionedLine,
  type PositionedTextDocument,
} from "../positioned/model";
import { extractLineItemsFromTable } from "../table/lineItems";
import type {
  FieldDescriptor,
  LineItemTableDescriptor,
  TemplateFieldKey,
  VendorTemplate,
} from "./types";

/**
 * Template application (briefing §3): evaluate each field descriptor against
 * the positioned text — works identically on Docling and OCR output because
 * both are normalized to the same representation.
 */

export interface TemplateApplication {
  envelope: ExtractionEnvelope;
  fieldsHit: string[];
  fieldsMissed: string[];
}

const REGION_INFLATE = 0.05;

function resolvePage(page: number, pageCount: number): number {
  return page === -1 ? pageCount : page;
}

interface FieldHit {
  raw: string;
  confidence: number;
  line: PositionedLine;
}

function findField(
  d: FieldDescriptor,
  doc: PositionedTextDocument,
): FieldHit | null {
  let candidates: PositionedLine[] = doc.lines;
  let hasRegion = false;
  if (d.region) {
    const page = resolvePage(d.region.page, doc.pageCount);
    const region = inflate(d.region.bbox, REGION_INFLATE);
    candidates = doc.lines.filter((l) => l.page === page && bboxIntersects(l.bbox, region));
    // Nearest-to-anchor first: the inflated region may catch neighboring lines
    // (and labels repeat on a page) — proximity to the recorded anchor decides.
    const cy = (d.region.bbox[1] + d.region.bbox[3]) / 2;
    const cx = (d.region.bbox[0] + d.region.bbox[2]) / 2;
    candidates = [...candidates].sort((a, b) => {
      const da = Math.hypot((a.bbox[0] + a.bbox[2]) / 2 - cx, (a.bbox[1] + a.bbox[3]) / 2 - cy);
      const db = Math.hypot((b.bbox[0] + b.bbox[2]) / 2 - cx, (b.bbox[1] + b.bbox[3]) / 2 - cy);
      return da - db;
    });
    hasRegion = true;
  }

  const label = d.label ? normalizeLabel(d.label) : null;
  const pattern = d.valuePattern ? new RegExp(d.valuePattern) : null;

  const tryValue = (text: string, hadLabel: boolean, line: PositionedLine): FieldHit | null => {
    let raw = text.trim();
    if (pattern) {
      const m = pattern.exec(raw);
      if (!m) return null;
      raw = m[0];
    }
    if (raw === "") return null;
    const confidence =
      hasRegion && hadLabel && pattern ? 0.95
      : hasRegion && pattern ? 0.8
      : hadLabel && pattern ? 0.75
      : hadLabel ? 0.6
      : hasRegion ? 0.5
      : 0.3;
    return { raw, confidence, line };
  };

  if (label) {
    for (let i = 0; i < candidates.length; i++) {
      const line = candidates[i]!;
      const norm = normalizeLabel(line.text);
      const idx = norm.indexOf(label);
      if (idx === -1) continue;
      // Same-line remainder after the label (via original text heuristics).
      const labelEnd = approximateLabelEnd(line.text, d.label!);
      const remainder = labelEnd !== null ? line.text.slice(labelEnd) : "";
      const cleaned = remainder.replace(/^[:\s]+/, "");
      const hit = tryValue(cleaned, true, line);
      if (hit) return hit;
      // Fall back to the next candidate line below with x-overlap.
      const below = candidates
        .filter(
          (l) =>
            l.page === line.page &&
            l.bbox[1] > line.bbox[3] - 0.005 &&
            l.bbox[0] < line.bbox[2] &&
            line.bbox[0] < l.bbox[2],
        )
        .sort((a, b) => a.bbox[1] - b.bbox[1])[0];
      if (below) {
        const belowHit = tryValue(below.text, true, below);
        if (belowHit) return belowHit;
      }
    }
    return null;
  }

  // No label: pattern (or first non-empty line) within the region.
  for (const line of candidates) {
    const hit = tryValue(line.text, false, line);
    if (hit) return hit;
  }
  return null;
}

/** Locate where a label ends inside the original (non-normalized) line text. */
function approximateLabelEnd(text: string, label: string): number | null {
  const idx = text.toLowerCase().indexOf(label.toLowerCase());
  if (idx !== -1) return idx + label.length;
  // Normalized fallback: walk the text accumulating normalized chars.
  const target = normalizeLabel(label);
  let acc = "";
  for (let i = 0; i < text.length; i++) {
    acc += normalizeLabel(text[i]!);
    if (acc.endsWith(target)) return i + 1;
  }
  return null;
}

function parseFieldValue(
  key: TemplateFieldKey,
  raw: string,
  template: VendorTemplate,
): string | null {
  if (key === "issueDate" || key === "dueDate") {
    return parseDateToIso(raw, template.locale.dateFormats);
  }
  if (key.startsWith("totals.")) {
    return parseAmount(raw, template.locale.decimal);
  }
  return raw;
}

/** Fuzzy header match: ≥70% of signature cells present (normalized). */
export function matchTable(
  tables: ExtractedTable[],
  descriptor: LineItemTableDescriptor,
): ExtractedTable | null {
  const signature = descriptor.headerSignature.map(normalizeLabel).filter((s) => s !== "");
  if (signature.length === 0) return null;
  let best: { table: ExtractedTable; score: number } | null = null;
  for (const table of tables) {
    const headers = table.headerCells.map(normalizeLabel);
    const hits = signature.filter((sig) => headers.some((h) => h === sig || h.includes(sig))).length;
    const score = hits / signature.length;
    if (score >= 0.7 && (best === null || score > best.score)) {
      best = { table, score };
    }
  }
  return best?.table ?? null;
}

function extractLines(
  table: ExtractedTable,
  descriptor: LineItemTableDescriptor,
  template: VendorTemplate,
): CandidateLineItem[] {
  return extractLineItemsFromTable(table, descriptor.columns, descriptor.descriptionContinuation, (s) =>
    parseAmount(s, template.locale.decimal),
  );
}

export function applyTemplate(
  template: VendorTemplate,
  doc: PositionedTextDocument,
): TemplateApplication {
  const invoice: CandidateInvoice = {};
  const fieldMeta: Record<string, FieldMeta> = {};
  const fieldsHit: string[] = [];
  const fieldsMissed: string[] = [];

  for (const [key, descriptor] of Object.entries(template.fields) as [TemplateFieldKey, FieldDescriptor][]) {
    const hit = findField(descriptor, doc);
    const value = hit ? parseFieldValue(key, hit.raw, template) : null;
    if (hit && value !== null) {
      setField(invoice, key, value);
      fieldMeta[key] = {
        source: "template",
        confidence: hit.confidence,
        rawText: hit.raw,
        anchor: { page: hit.line.page, bbox: hit.line.bbox },
      };
      fieldsHit.push(key);
    } else {
      fieldsMissed.push(key);
    }
  }

  if (template.lineItemTable) {
    const table = matchTable(doc.tables, template.lineItemTable);
    if (table) {
      const items = extractLines(table, template.lineItemTable, template);
      if (items.length > 0) {
        invoice.lineItems = items;
        items.forEach((_, i) => {
          fieldMeta[`lineItems.${i}`] = { source: "template", confidence: 0.85 };
        });
        fieldsHit.push("lineItems");
      } else {
        fieldsMissed.push("lineItems");
      }
    } else {
      fieldsMissed.push("lineItems");
    }
  }

  // Vendor identity travels with the template (it resolved the lookup).
  const ids = template.vendorIds;
  invoice.seller = {
    name: ids.displayName ?? null,
    ustIdNr: ids.ustIdNr ?? null,
    steuernummer: ids.steuernummer ?? null,
    ibans: ids.ibans ?? [],
  };
  if (ids.displayName) fieldMeta["seller.name"] = { source: "template", confidence: 0.9 };

  return { envelope: { invoice, fieldMeta }, fieldsHit, fieldsMissed };
}

function setField(invoice: CandidateInvoice, key: TemplateFieldKey, value: string): void {
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
