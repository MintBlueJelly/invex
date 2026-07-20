import { parseAmount } from "../parsing/amounts";
import { isValidUstIdNr } from "../vendor/checksums";
import { normalizeLabel, type PositionedTextDocument } from "../positioned/model";
import { parseDateToIso } from "../parsing/dates";

/**
 * Weighted-feature-score classifier (briefing §5). No trained model in MVP:
 * deterministic binary features × config weights → three bands. Weights and
 * band thresholds are PROVISIONAL until calibrated on a labeled sample (§11);
 * the full feature vector is logged on every document to enable exactly that.
 */

export interface ClassifierConfigCore {
  weights: Record<string, number>;
  bands: { invoiceMin: number; nonInvoiceMax: number };
}

export type ClassifierBand = "invoice" | "non_invoice" | "uncertain";

export interface ClassificationResult {
  features: Record<string, 0 | 1>;
  score: number;
  band: ClassifierBand;
}

type Feature = (doc: PositionedTextDocument) => boolean;

/** F1: "Rechnung"/"Invoice" in a heading position. */
const f1HeadingKeyword: Feature = (doc) =>
  doc.lines.some((l) => {
    const isHeadingTag = l.tag === "section_header" || l.tag === "title";
    const isTop = l.page === 1 && l.bbox[1] < 0.25;
    return (
      (isHeadingTag || isTop) &&
      /\b(rechnung|invoice|gutschrift|credit\s?note)\b/i.test(l.text) &&
      l.text.trim().length < 60
    );
  });

/** F2: invoice-number pattern adjacent to a number label. */
const f2InvoiceNumberPattern: Feature = (doc) =>
  doc.lines.some(
    (l) =>
      /(rechnungs?-?\s?(nr|nummer)|invoice\s?(no|number|#)|beleg-?(nr|nummer))/i.test(l.text) &&
      /[A-Za-z]{0,4}[-/]?\d[\dA-Za-z\-/._]{2,}/.test(l.text),
  );

/** F3: checksum-valid USt-IdNr or labeled Steuernummer present. */
const f3TaxIdPresent: Feature = (doc) => {
  const all = doc.lines.map((l) => l.text).join("\n");
  for (const m of all.matchAll(/\bDE\s?\d{9}\b/g)) {
    if (isValidUstIdNr(m[0].replace(/\s+/g, ""))) return true;
  }
  return doc.lines.some(
    (l) => /steuernummer|steuer-?nr/i.test(l.text) && /\d{2,3}\/\d{3,4}\/\d{4,5}|\d{10,13}/.test(l.text),
  );
};

/** F4: a date labeled as invoice date. */
const f4LabeledInvoiceDate: Feature = (doc) =>
  doc.lines.some((l) => {
    if (!/(rechnungs|beleg|invoice)\s?-?\s?(datum|date)|date\s+of\s+issue/i.test(l.text)) return false;
    const m = /\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/.exec(l.text);
    return m !== null && parseDateToIso(m[0]) !== null;
  });

/** F5: VAT breakdown block — closed-set percentage adjacent to an amount. */
const f5VatBreakdownBlock: Feature = (doc) =>
  doc.lines.some((l) =>
    /(mwst|mehrwertsteuer|ust|umsatzsteuer|vat|tax)[^%\d]{0,20}(19|7|0)\s?%[^\d]{0,10}-?[\d.,]+/i.test(l.text),
  );

/** F6: ≥1 table where ≥60% of some column parses as a currency amount. */
const f6CurrencyAmountTable: Feature = (doc) =>
  doc.tables.some((t) => {
    if (t.rows.length === 0) return false;
    const cols = Math.max(...t.rows.map((r) => r.length));
    for (let c = 0; c < cols; c++) {
      const cells = t.rows.map((r) => r[c] ?? "").filter((v) => v.trim() !== "");
      if (cells.length === 0) continue;
      const amounts = cells.filter((v) => {
        const parsed = parseAmount(v);
        return parsed !== null && /[.,]\d{2}$/.test(v.trim().replace(/\s*(EUR|€)$/i, ""));
      }).length;
      if (amounts / cells.length >= 0.6) return true;
    }
    return false;
  });

const FEATURES: Record<string, Feature> = {
  F1_headingKeyword: f1HeadingKeyword,
  F2_invoiceNumberPattern: f2InvoiceNumberPattern,
  F3_taxIdPresent: f3TaxIdPresent,
  F4_labeledInvoiceDate: f4LabeledInvoiceDate,
  F5_vatBreakdownBlock: f5VatBreakdownBlock,
  F6_currencyAmountTable: f6CurrencyAmountTable,
};

export function classify(doc: PositionedTextDocument, config: ClassifierConfigCore): ClassificationResult {
  const features: Record<string, 0 | 1> = {};
  let score = 0;
  for (const [name, fn] of Object.entries(FEATURES)) {
    const on = fn(doc) ? 1 : 0;
    features[name] = on;
    score += on * (config.weights[name] ?? 0);
  }
  const band: ClassifierBand =
    score >= config.bands.invoiceMin
      ? "invoice"
      : score <= config.bands.nonInvoiceMax
        ? "non_invoice"
        : "uncertain";
  return { features, score, band };
}

/** Cheap Markdown rendition from positioned text (fallback when Docling's own
 *  markdown is unavailable, e.g. sliced segments). */
export function positionedToMarkdown(doc: PositionedTextDocument): string {
  const parts: string[] = [];
  let page = 0;
  for (const line of doc.lines) {
    if (line.page !== page) {
      page = line.page;
      if (page > 1) parts.push("\n---\n");
    }
    if (line.tag === "section_header" || line.tag === "title") parts.push(`## ${line.text}`);
    else parts.push(line.text);
  }
  for (const t of doc.tables) {
    parts.push("");
    parts.push(`| ${t.headerCells.join(" | ")} |`);
    parts.push(`| ${t.headerCells.map(() => "---").join(" | ")} |`);
    for (const row of t.rows) parts.push(`| ${row.join(" | ")} |`);
  }
  return parts.join("\n");
}
