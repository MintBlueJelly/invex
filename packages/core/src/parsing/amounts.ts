/**
 * Locale-aware monetary parsing (briefing §3 rule engine + template locale):
 * "1.234,56" (de) vs "1,234.56" (en) → dot-decimal string. Never float.
 */

export type DecimalSeparator = "," | ".";

/** Strip currency symbols/codes and surrounding junk, keep sign/digits/separators. */
function stripNoise(text: string): string {
  return text
    .replace(/(EUR|€|USD|\$|GBP|£|CHF)/gi, "")
    .replace(/[^\d.,\-+]/g, "")
    .trim();
}

/**
 * Detect the decimal separator of a rendered amount: the LAST separator
 * followed by exactly 1–2 trailing digits is decimal; everything else groups.
 */
export function detectDecimalSeparator(text: string): DecimalSeparator | null {
  const s = stripNoise(text);
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot === -1 && lastComma === -1) return null;
  const pos = Math.max(lastDot, lastComma);
  const sep = s[pos] as DecimalSeparator;
  const trailing = s.slice(pos + 1);
  if (/^\d{1,2}$/.test(trailing)) return sep;
  // "1.234" / "1,234" — 3 trailing digits is grouping, not decimals.
  return null;
}

/**
 * Parse a rendered amount to a dot-decimal string. `decimal` pins the locale
 * (from a vendor template); otherwise it is auto-detected per value.
 */
export function parseAmount(text: string, decimal?: DecimalSeparator): string | null {
  let s = stripNoise(text);
  if (s === "" || /^[-+]$/.test(s)) return null;
  const negative = s.startsWith("-");
  s = s.replace(/^[-+]/, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;

  const sep = decimal ?? detectDecimalSeparator(s);
  let intPart: string;
  let fracPart = "";
  if (sep && s.includes(sep)) {
    const pos = s.lastIndexOf(sep);
    intPart = s.slice(0, pos);
    fracPart = s.slice(pos + 1);
    if (!/^\d{1,4}$/.test(fracPart)) return null;
  } else {
    intPart = s;
  }
  intPart = intPart.replace(/[.,]/g, "");
  if (!/^\d*$/.test(intPart)) return null;
  if (intPart === "") intPart = "0";
  if (intPart.length > 12) return null;
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${out}` : out;
}

/** Render a dot-decimal string in a locale (used by template induction search). */
export function renderAmount(dotDecimal: string, decimal: DecimalSeparator, grouped = true): string {
  const negative = dotDecimal.startsWith("-");
  const [rawInt = "0", frac = ""] = (negative ? dotDecimal.slice(1) : dotDecimal).split(".");
  const group = decimal === "," ? "." : ",";
  const int = grouped ? rawInt.replace(/\B(?=(\d{3})+(?!\d))/g, group) : rawInt;
  const fracPart = frac ? `${decimal}${frac}` : "";
  return `${negative ? "-" : ""}${int}${fracPart}`;
}
