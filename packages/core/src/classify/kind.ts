import { foldText, spellingVariants } from "../text/fold";
import type {
  Bbox,
  PositionedLine,
  PositionedTextDocument,
  PositionedToken,
} from "../positioned/model";
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
 * The cap that stops a body sentence in the top band from announcing a class:
 * "Wir bestätigen Ihnen den Auftrag wie folgt und liefern …" would otherwise
 * read as an orderConfirmation.
 */
const HEADING_MAX_CHARS = 60;

/**
 * Wider than any inter-word space — ~0.005 at 10pt on A4, and 0.018 in the test
 * builders — and far narrower than the 0.108 column gap measured above. In
 * production it is only ever reached by merged OCR lines, whose tokens are
 * whole pre-merge text blocks rather than words; a Docling line has one token
 * and never reaches the split at all.
 */
const RUN_GAP = 0.04;

interface HeadingRun {
  text: string;
  bbox: Bbox;
}

/** Token groups separated by a horizontal gap — the visual columns of one row. */
function visualRuns(line: PositionedLine): HeadingRun[] {
  if (line.tokens.length <= 1) return [{ text: line.text, bbox: line.bbox }];

  const sorted = [...line.tokens].sort((a, b) => a.bbox[0] - b.bbox[0]);
  const groups: PositionedToken[][] = [];
  let current: PositionedToken[] = [];
  let right = -Infinity;
  for (const token of sorted) {
    if (current.length > 0 && token.bbox[0] - right > RUN_GAP) {
      groups.push(current);
      current = [];
    }
    current.push(token);
    right = Math.max(right, token.bbox[2]);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => ({
    text: group.map((t) => t.text).join(" "),
    bbox: [
      Math.min(...group.map((t) => t.bbox[0])),
      Math.min(...group.map((t) => t.bbox[1])),
      Math.max(...group.map((t) => t.bbox[2])),
      Math.max(...group.map((t) => t.bbox[3])),
    ] as Bbox,
  }));
}

/**
 * The runs of `line` short enough, and placed well enough, to be a heading.
 *
 * INVEX-059 — why the cap is per RUN and not per line. On a German letterhead
 * the title sits on the same text row as the Absenderzeile, the small-print
 * sender line above the address window. Measured on a real Auftragsbestätigung:
 * the sender line ends at x=0.48 and the title starts at x=0.59, same row.
 * `mergeLines` clusters at yTolerance 0.008, so Path C handed this gate one
 * fused 85-character line — over the cap, and the document's only heading
 * evidence was gone. Splitting on the horizontal gap recovers it.
 *
 * A Docling text item carries a single token spanning the whole line, so on
 * Path B a line is always exactly one run and nothing here changes.
 */
export function headingCandidateRuns(line: PositionedLine): HeadingRun[] {
  const isHeadingTag = line.tag === "section_header" || line.tag === "title";
  const isTop = line.page === 1 && line.bbox[1] < 0.25;
  if (!isHeadingTag && !isTop) return [];
  return visualRuns(line).filter((run) => {
    const len = run.text.trim().length;
    return len > 0 && len < HEADING_MAX_CHARS;
  });
}

/** Identical to F1's gate (classifier.ts) and shared with it. */
export function isHeadingCandidate(line: PositionedLine): boolean {
  return headingCandidateRuns(line).length > 0;
}

/** Tag tier: an explicit layout heading outranks a line that merely sits high. */
function tier(line: PositionedLine): number {
  if (line.tag === "title") return 0;
  if (line.tag === "section_header") return 1;
  return 2;
}

export function detectKind(doc: PositionedTextDocument): KindEvidence {
  const hits: { line: PositionedLine; run: HeadingRun; kind: DocumentType; term: string }[] = [];
  const fired = new Set<DocumentType>();

  for (const line of doc.lines) {
    for (const run of headingCandidateRuns(line)) {
      const folded = foldText(run.text);
      let runWinner: { kind: DocumentType; term: string } | null = null;
      for (const [kind, pattern] of KIND_PATTERNS) {
        const m = pattern.exec(folded);
        if (!m) continue;
        fired.add(kind);
        // Precedence within one run: KIND_PATTERNS is in PRECEDENCE order, so
        // the first match is the winner. The loop still runs to completion so
        // `competing` records every class that fired, which is what makes the
        // escalation log useful for calibration.
        runWinner ??= { kind, term: m[0] };
      }
      if (runWinner) hits.push({ line, run, ...runWinner });
    }
  }

  if (hits.length === 0) return NO_EVIDENCE;

  const competing = DOCUMENT_TYPES.filter((t) => fired.has(t));

  // Position beats lexicon: best tag tier first, then highest on the page. Both
  // keys stay on the LINE, so two runs of one row remain exactly tied and reach
  // the ambiguity check below rather than being separated by a font-height
  // difference between them.
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
    // The RUN's box, not the line's: on a fused letterhead row the line box
    // spans the page and would anchor a template to the wrong place.
    anchor: { page: best.line.page, bbox: best.run.bbox },
    competing,
  };
}
