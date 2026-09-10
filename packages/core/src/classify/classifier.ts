import { parseAmount } from "../parsing/amounts";
import { isValidUstIdNr } from "../vendor/checksums";
import type { PositionedTextDocument } from "../positioned/model";
import { parseDateToIso } from "../parsing/dates";
import { foldText } from "../text/fold";
import { detectKind, type KindEvidence } from "./kind";
import type { DocumentType } from "../schema/documentType";

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
  /** Which document class the heading announces, if any (classify/kind.ts). */
  kind: DocumentType | null;
  kindEvidence: KindEvidence;
}

type Feature = (doc: PositionedTextDocument) => boolean;

/**
 * F1: a recognised document-class word in a heading position.
 *
 * Delegates to detectKind so the classifier and the kind detector share one
 * keyword table and cannot drift apart. The feature's MEANING widened from "is
 * an invoice heading" to "is a structured-commercial-document heading"; its key
 * and weight are unchanged on purpose (calibration continuity, briefing §11).
 */
const f1HeadingKeyword: Feature = (doc) => detectKind(doc).kind !== null;

/**
 * A number label for any of the five document classes. The short forms
 * ("AB-Nr.") are safe only because nr/nummer is required in the same match — a
 * bare \bab\b would fire on "ab 01.01.2026" and "ab Werk".
 */
const DOCUMENT_NUMBER_LABEL =
  /(rechnungs?|auftrags?|auftragsbestae?tigungs?|bestell|liefer|lieferschein|angebots?|gutschrifts?|beleg|dokument|vorgangs?|invoice|order|delivery|quote|quotation|document)\s?-?\s?(nr|nummer|no|number|#)|\b(ab|ls|an|re|gs|kv|best)\s?[-.]?\s?(nr|nummer)\b/;

/**
 * F2: a document-number pattern adjacent to a number label.
 *
 * Key kept as F2_invoiceNumberPattern although it now covers every document
 * class: the persisted feature vectors are the labeled sample the band
 * calibration is waiting for (briefing §11), and renaming would split that
 * corpus in half. Read the F-ids as opaque calibration identifiers, not
 * descriptions.
 */
const f2InvoiceNumberPattern: Feature = (doc) =>
  doc.lines.some(
    (l) =>
      DOCUMENT_NUMBER_LABEL.test(foldText(l.text)) &&
      /[A-Za-z]{0,4}[-/]?\d[\dA-Za-z\-/._]{2,}/.test(l.text),
  );

/** F3: checksum-valid USt-IdNr or labeled Steuernummer present. */
const f3TaxIdPresent: Feature = (doc) => {
  const all = doc.lines.map((l) => l.text).join("\n");
  for (const m of all.matchAll(/\bDE\s?\d{9}\b/g)) {
    if (isValidUstIdNr(m[0].replace(/\s+/g, ""))) return true;
  }
  return doc.lines.some(
    (l) =>
      /steuernummer|steuer-?nr/.test(foldText(l.text)) &&
      /\d{2,3}\/\d{3,4}\/\d{4,5}|\d{10,13}/.test(l.text),
  );
};

/**
 * Bare "Datum" stays OUT of this set deliberately, and should not be "fixed"
 * in: every document class prints it, covering letters included, so including
 * it would destroy the feature's discriminative power.
 */
const DOCUMENT_DATE_LABEL =
  /(rechnungs|beleg|auftrags|auftragsbestae?tigungs|bestell|liefer|lieferschein|angebots|gutschrifts|dokument|invoice|order|delivery|quote|document)\s?-?\s?(datum|date)|date\s+of\s+issue|\bausstellungsdatum\b/;

/** F4: a date labeled as the document's own date. Key kept — see F2. */
const f4LabeledInvoiceDate: Feature = (doc) =>
  doc.lines.some((l) => {
    if (!DOCUMENT_DATE_LABEL.test(foldText(l.text))) return false;
    const m = /\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/.exec(l.text);
    return m !== null && parseDateToIso(m[0]) !== null;
  });

/** F5: VAT breakdown block — closed-set percentage adjacent to an amount. */
const f5VatBreakdownBlock: Feature = (doc) =>
  doc.lines.some((l) =>
    /(mwst|mehrwertsteuer|ust|umsatzsteuer|vat|tax)[^%\d]{0,20}(19|7|0)\s?%[^\d]{0,10}-?[\d.,]+/.test(
      foldText(l.text),
    ),
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
  const kindEvidence = detectKind(doc);
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
  return { features, score, band, kind: kindEvidence.kind, kindEvidence };
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
