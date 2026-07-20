import type { PositionedTextDocument } from "../positioned/model";
import { GATE_WORDS } from "./words";

/**
 * Text-quality gate (briefing §2 Path B step 1): heuristic check of the
 * embedded text layer. Garbage layers from bad upstream OCR are rerouted to
 * Path C instead of poisoning table extraction and classification.
 */

export interface TextGateOptions {
  minDictHitRate: number;
  maxReplacementCharRatio: number;
  maxSingleCharTokenRatio: number;
  minTokensForVerdict: number;
}

export interface TextGateResult {
  verdict: "ok" | "garbage";
  dictHitRate: number | null;
  cidTokens: number;
  replacementRatio: number;
  singleCharRatio: number;
  tokensConsidered: number;
  reasons: string[];
}

const wordSet = new Set(GATE_WORDS);
const substringWords = GATE_WORDS.filter((w) => w.length >= 4 && w.length <= 12);

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

export function runTextGate(doc: PositionedTextDocument, opts: TextGateOptions): TextGateResult {
  const fullText = doc.lines.map((l) => l.text).join("\n");
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

  if (cidTokens > 0) reasons.push(`cid_tokens=${cidTokens}`);
  if (replacementRatio > opts.maxReplacementCharRatio) reasons.push(`replacement_ratio=${replacementRatio.toFixed(3)}`);
  if (singleCharRatio > opts.maxSingleCharTokenRatio && alpha.length >= opts.minTokensForVerdict) {
    reasons.push(`single_char_ratio=${singleCharRatio.toFixed(2)}`);
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
    tokensConsidered: considered.length,
    reasons,
  };
}
