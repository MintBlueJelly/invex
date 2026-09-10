/**
 * Diacritic- and ß-insensitive text fold that PRESERVES whitespace and
 * punctuation, so `\b` word boundaries survive it.
 *
 * Why a third normalizer, when core already has two:
 *
 * - `normalizeLabel` (positioned/model.ts) strips every separator, so
 *   "Rechnungs-Nr." becomes "rechnungsnr". That is correct for the rule
 *   engine, which compares whole labels, and useless for a `\b`-anchored
 *   prose regex — after it, word boundaries no longer exist.
 * - `normalizeToken` (textquality/gate.ts) is token-scoped and private to the
 *   dictionary gate; reusing it here would couple keyword matching to the
 *   gate's `minDictHitRate` calibration.
 *
 * The classifier historically did no folding at all, which was survivable only
 * because none of its six German keyword sets contained an umlaut. Recognising
 * "Auftragsbestätigung" ends that.
 */

/**
 * Fold for keyword matching: lowercase, ß→ss, strip diacritics — and nothing
 * else. Whitespace, hyphens, periods and colons all survive, which is the
 * whole point.
 *
 * Do NOT map match offsets in the folded string back to the original: ß→ss is
 * the one step that is not 1:1 per code point. Report the matched folded term
 * alongside the verbatim source line instead.
 */
export function foldText(s: string): string {
  return (
    s
      .toLowerCase()
      // Must precede NFD: ß has no decomposition and would otherwise survive
      // as a non-[a-z] character in the middle of an otherwise ASCII word.
      .replace(/ß/g, "ss")
      .replace(/æ/g, "ae")
      .replace(/œ/g, "oe")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
  );
}

/**
 * Both machine spellings of a term written in natural German, so keyword
 * tables can be authored readably ("Auftragsbestätigung") and still match
 * documents that print the ASCII transliteration ("Auftragsbestaetigung").
 *
 *   "Auftragsbestätigung" → ["auftragsbestatigung", "auftragsbestaetigung"]
 *
 * Note the direction: variants are EXPANDED, never collapsed. A fold that
 * mapped "ue"→"u" to unify the two spellings would also map "steuer"→"stur",
 * silently killing the tax-ID and VAT keyword sets that F3 and F5 depend on.
 */
export function spellingVariants(term: string): string[] {
  const folded = foldText(term);
  const transliterated = foldText(
    term.replace(/ä/gi, "ae").replace(/ö/gi, "oe").replace(/ü/gi, "ue"),
  );
  return folded === transliterated ? [folded] : [folded, transliterated];
}
