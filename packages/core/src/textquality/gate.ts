import type { PositionedTextDocument } from "../positioned/model";
import { GATE_WORDS } from "./words";

/**
 * Text-quality gate (briefing §2 Path B step 1): heuristic check of the
 * embedded text layer. Garbage layers from bad upstream OCR are rerouted to
 * Path C instead of poisoning table extraction and classification.
 *
 * INVEX-047 — what this gate asks, and what it used to ask.
 *
 * It used to ask "does this read like vocabulary I know?", vetoing anything
 * under a 0.55 dictionary hit rate. A 340-word list cannot answer that about a
 * real page. A genuine German Auftragsbestätigung scores 0.37 over the whole
 * document and 0.48 over its cleanest prose paragraph — the misses are ordinary
 * German the list omits (sehr, geehrte, ihnen, telefon), proper nouns and
 * product vocabulary. 0.55 was calibrated on synthetic fixtures of 18-43 tokens
 * built out of this very word list, so it only ever measured the corpus against
 * itself; the cost fell on the deterministic path the design exists to widen.
 *
 * The question worth asking is narrower: is this text LAYER broken? A wrong
 * CMap, a missing ToUnicode table or misdecoded OCR yields words that are
 * structurally impossible rather than merely unfamiliar — and that is
 * language-agnostic, which a German+English word list is not. Measured on one
 * document against a shifted-encoding copy of itself: implausible-token ratio
 * 0.06 vs 0.51, dictionary rate 0.37 vs 0.00. Over the golden corpus plus real
 * documents the two populations separate at 0.16 / 0.51, and the threshold sits
 * in that gap.
 *
 * So consonant structure is the discriminator now, and the dictionary rate
 * survives only as a FLOOR — "not one recognisable word anywhere on the page" —
 * which garbage hits exactly and no legible page ever does.
 */

export interface TextGateOptions {
  /**
   * A FLOOR, not a prose test: under this, NOTHING on the page was recognisable.
   * Deliberately far below what real prose scores — see the note above.
   */
  minDictHitRate: number;
  maxReplacementCharRatio: number;
  maxSingleCharTokenRatio: number;
  /**
   * Fraction of words that cannot be words: no vowel at all, or a run of five
   * or more non-vowels. "GmbH" and "HRB" are legitimately vowel-less and recur
   * on every German letterhead, which is why this is a ratio and not a count.
   */
  maxConsonantRunRatio: number;
  minTokensForVerdict: number;
}

export interface TextGateResult {
  verdict: "ok" | "garbage";
  dictHitRate: number | null;
  cidTokens: number;
  replacementRatio: number;
  singleCharRatio: number;
  consonantRunRatio: number;
  tokensConsidered: number;
  reasons: string[];
}

const wordSet = new Set(GATE_WORDS);
const substringWords = GATE_WORDS.filter((w) => w.length >= 4 && w.length <= 12);

/** Runs on already-normalized tokens, so the diacritics are gone and "y" counts. */
const IMPLAUSIBLE_SHAPE = /^[^aeiouy]+$|[^aeiouy]{5,}/;

function normalizeToken(t: string): string {
  return t
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Compound-aware dictionary hit: exact, or a dictionary word inside the token. */
function isDictHit(token: string): boolean {
  if (wordSet.has(token)) return true;
  if (token.length >= 6) {
    for (const w of substringWords) {
      if (token.includes(w)) return true;
    }
  }
  return false;
}

/**
 * Everything the page says — INCLUDING table cells (INVEX-047, second cause).
 * Reading `doc.lines` alone judged the text layer while never seeing the part
 * of the page carrying most of its words: on `de-standard-19` the line text
 * does not contain "Aktenvernichter" at all, the table does.
 */
function gatheredText(doc: PositionedTextDocument): string {
  const parts = doc.lines.map((l) => l.text);
  for (const table of doc.tables) {
    parts.push(table.headerCells.join(" "));
    for (const row of table.rows) parts.push(row.join(" "));
  }
  return parts.join("\n");
}

export function runTextGate(doc: PositionedTextDocument, opts: TextGateOptions): TextGateResult {
  const fullText = gatheredText(doc);
  const reasons: string[] = [];

  // Hard garbage markers.
  const cidTokens = (fullText.match(/\(cid:\d+\)/g) ?? []).length;
  const replacementRatio =
    fullText.length === 0 ? 0 : (fullText.match(/�/g) ?? []).length / fullText.length;

  const rawTokens = fullText.split(/[^\p{L}]+/u).filter((t) => t.length > 0);
  const alpha = rawTokens.map(normalizeToken);
  const singleChar = alpha.filter((t) => t.length === 1).length;
  const singleCharRatio = alpha.length === 0 ? 0 : singleChar / alpha.length;

  const considered = alpha.filter((t) => t.length >= 4);
  const hits = considered.filter(isDictHit).length;
  const dictHitRate = considered.length >= opts.minTokensForVerdict ? hits / considered.length : null;
  const implausible = considered.filter((t) => IMPLAUSIBLE_SHAPE.test(t)).length;
  const consonantRunRatio = considered.length === 0 ? 0 : implausible / considered.length;

  if (cidTokens > 0) reasons.push(`cid_tokens=${cidTokens}`);
  if (replacementRatio > opts.maxReplacementCharRatio) reasons.push(`replacement_ratio=${replacementRatio.toFixed(3)}`);
  if (singleCharRatio > opts.maxSingleCharTokenRatio && alpha.length >= opts.minTokensForVerdict) {
    reasons.push(`single_char_ratio=${singleCharRatio.toFixed(2)}`);
  }
  // Gated on the same evidence floor as the ratios above: three junk tokens are
  // not a broken text layer. That floor is INVEX-015 and is not addressed here.
  if (consonantRunRatio > opts.maxConsonantRunRatio && considered.length >= opts.minTokensForVerdict) {
    reasons.push(`consonant_run_ratio=${consonantRunRatio.toFixed(2)}`);
  }
  if (dictHitRate !== null && dictHitRate < opts.minDictHitRate) {
    reasons.push(`dict_hit_rate=${dictHitRate.toFixed(2)}`);
  }

  return {
    verdict: reasons.length > 0 ? "garbage" : "ok",
    dictHitRate,
    cidTokens,
    replacementRatio,
    singleCharRatio,
    consonantRunRatio,
    tokensConsidered: considered.length,
    reasons,
  };
}
