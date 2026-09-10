import { foldText, spellingVariants } from "../text/fold";
import type { Bbox, PositionedLine, PositionedTextDocument } from "../positioned/model";
import { DOCUMENT_TYPES, type DocumentType } from "../schema/documentType";

/**
 * Document-class detection from the heading (briefing §5, extended beyond the
 * MVP's invoice/non-invoice split).
 *
 * Kept deliberately separate from the weighted feature score. The score is a
 * CALIBRATION artifact — provisional weights summed into three bands, with the
 * feature vector persisted on every document so the bands can be tuned against
 * a labeled sample (§11). Kind is a NOMINAL label. Folding the two together
 * would mean either a weight that means "is an Auftragsbestätigung" competing
 * against one that means "has a VAT block", or one feature per class whose
 * winner is read back out of the feature dict — a kind detector wearing a
 * feature costume, with the weights now lying about their meaning.
 *
 * F1_headingKeyword delegates here, so the classifier and the kind detector
 * cannot drift apart.
 */

/** Terms written in natural German; both machine spellings are derived below. */
const KIND_TERMS: Readonly<Record<DocumentType, readonly string[]>> = {
  // Ordered within each list longest-first is unnecessary (\b prevents prefix
  // bleed) but harmless; ordering ACROSS lists is load-bearing — see PRECEDENCE.
  creditNote: [
    "Gutschrift",
    "Gutschriftanzeige",
    "Rechnungskorrektur",
    "Korrekturrechnung",
    "Stornorechnung",
    "Storno-Rechnung",
    "Stornobeleg",
    "Credit Note",
    "Creditnote",
    "Credit Memo",
  ],
  invoice: [
    "Rechnung",
    "Schlussrechnung",
    "Abschlagsrechnung",
    "Teilrechnung",
    "Anzahlungsrechnung",
    "Vorausrechnung",
    "Proformarechnung",
    "Proforma-Rechnung",
    "Honorarrechnung",
    "Eingangsrechnung",
    "Ausgangsrechnung",
    "Invoice",
    "Tax Invoice",
    "Commercial Invoice",
    // Deliberately NOT "Bill" — collides with the "Bill to" address label.
  ],
  orderConfirmation: [
    "Auftragsbestätigung",
    "Bestellbestätigung",
    "Auftragsannahme",
    "Order Confirmation",
    "Order Acknowledgement",
    "Order Acknowledgment",
    "Sales Order Confirmation",
    "Confirmation of Order",
    // Deliberately NOT bare "AB": \bab\b matches "ab 01.01.2026" and "ab Werk".
    // The "AB-Nr." form is safe, and lives in the classifier's F2 label set.
  ],
  quote: [
    "Angebot",
    "Angebotsschreiben",
    "Kostenvoranschlag",
    "Kostenschätzung",
    "Offerte",
    "Preisangebot",
    "Quote",
    "Quotation",
    "Estimate",
    // Deliberately NOT "Proposal" — too generic in German business letters.
  ],
  deliveryNote: [
    "Lieferschein",
    "Warenbegleitschein",
    "Versandanzeige",
    "Lieferavis",
    "Packliste",
    "Packzettel",
    "Delivery Note",
    "Packing List",
    "Packing Slip",
    "Despatch Advice",
    "Dispatch Note",
  ],
};

/**
 * Order in which competing matches ON THE SAME LINE are resolved.
 *
 * Concrete reason this exists, not an aesthetic ranking: a heading reading
 * "Rechnungskorrektur zu Rechnung R-2026-0042" contains a second, bare
 * "Rechnung" that DOES satisfy /\brechnung\b/. Without creditNote ranking above
 * invoice, that document commits as an invoice. "Gutschrift zur Rechnung …"
 * has the same shape.
 */
const PRECEDENCE: readonly DocumentType[] = [
  "creditNote",
  "invoice",
  "orderConfirmation",
  "quote",
  "deliveryNote",
];

/**
 * One `\b`-anchored alternation per class, over FOLDED text.
 *
 * Every German compound is listed explicitly in KIND_TERMS because there is no
 * prefix magic to rely on: /\brechnung\b/ does not match "Schlussrechnung" (no
 * boundary between "s" and "r") nor "Rechnungskorrektur" (no trailing
 * boundary). That is the same property that stops the label "Rechnungsdatum"
 * from firing F1 today, and it cuts both ways.
 *
 * Hyphenated compounds are the exception worth knowing about: "-" is a
 * non-word character, so /\brechnung\b/ DOES match the tail of
 * "Storno-Rechnung". Precedence, not the regex, is what keeps that a creditNote.
 */
const KIND_PATTERNS: ReadonlyArray<readonly [DocumentType, RegExp]> = PRECEDENCE.map((kind) => {
  const alternatives = [...KIND_TERMS[kind]]
    .flatMap(spellingVariants)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  return [kind, new RegExp(`\\b(?:${alternatives.join("|")})\\b`)] as const;
});

export interface KindEvidence {
  kind: DocumentType | null;
  /** The folded term that fired — for §11 calibration, not for display. */
  matchedTerm: string | null;
  /** Verbatim source line, so the escalation log stays human-readable. */
  rawLine: string | null;
  anchor: { page: number; bbox: Bbox } | null;
  /** Every class that fired on any eligible line, even when kind is null. */
  competing: DocumentType[];
}

const NO_EVIDENCE: KindEvidence = {
  kind: null,
  matchedTerm: null,
  rawLine: null,
  anchor: null,
  competing: [],
};

/**
 * A line may carry the document's class only if it is in heading position.
 *
 * Identical to F1's gate (classifier.ts) and shared with it. The <60-char cap
 * is load-bearing for the new classes specifically: "Wir bestätigen Ihnen den
 * Auftrag wie folgt und liefern …" is a body sentence sitting in the top band
 * that would otherwise announce an orderConfirmation.
 */
export function isHeadingCandidate(line: PositionedLine): boolean {
  const isHeadingTag = line.tag === "section_header" || line.tag === "title";
  const isTop = line.page === 1 && line.bbox[1] < 0.25;
  return (isHeadingTag || isTop) && line.text.trim().length < 60;
}

/** Tag tier: an explicit layout heading outranks a line that merely sits high. */
function tier(line: PositionedLine): number {
  if (line.tag === "title") return 0;
  if (line.tag === "section_header") return 1;
  return 2;
}

export function detectKind(doc: PositionedTextDocument): KindEvidence {
  const hits: { line: PositionedLine; kind: DocumentType; term: string }[] = [];
  const fired = new Set<DocumentType>();

  for (const line of doc.lines) {
    if (!isHeadingCandidate(line)) continue;
    const folded = foldText(line.text);
    let lineWinner: { kind: DocumentType; term: string } | null = null;
    for (const [kind, pattern] of KIND_PATTERNS) {
      const m = pattern.exec(folded);
      if (!m) continue;
      fired.add(kind);
      // Precedence within one line: KIND_PATTERNS is in PRECEDENCE order, so
      // the first match is the winner. The loop still runs to completion so
      // `competing` records every class that fired, which is what makes the
      // escalation log useful for calibration.
      lineWinner ??= { kind, term: m[0] };
    }
    if (lineWinner) hits.push({ line, ...lineWinner });
  }

  if (hits.length === 0) return NO_EVIDENCE;

  const competing = DOCUMENT_TYPES.filter((t) => fired.has(t));

  // Position beats lexicon: best tag tier first, then highest on the page.
  const ranked = [...hits].sort(
    (a, b) => tier(a.line) - tier(b.line) || a.line.bbox[1] - b.line.bbox[1],
  );
  const best = ranked[0]!;

  // Two equally-ranked headings disagreeing is not a tie to break by guessing.
  // A wrong type is worse than none: kind null plus a strong score routes
  // exactly as an invoice does today.
  const runnerUp = ranked[1];
  const ambiguous =
    runnerUp !== undefined &&
    runnerUp.kind !== best.kind &&
    tier(runnerUp.line) === tier(best.line) &&
    runnerUp.line.bbox[1] === best.line.bbox[1];

  if (ambiguous) return { ...NO_EVIDENCE, competing };

  return {
    kind: best.kind,
    matchedTerm: best.term,
    rawLine: best.line.text,
    anchor: { page: best.line.page, bbox: best.line.bbox },
    competing,
  };
}
