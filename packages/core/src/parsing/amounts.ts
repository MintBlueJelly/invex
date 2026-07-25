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
 * Does this text hold more than one amount?
 *
 * Two adjacent table cells merged by a layout error arrive here as
 * "199,50 399,00". stripNoise() removes the space, fusing them into
 * 19950399.00 — schema-valid, arithmetically unremarkable, and unrecognisable
 * as wrong by any downstream constraint (INVEX-003). Declining is strictly
 * better: a null is a missing field, which the solver reports.
 *
 * Space-grouped numbers stay valid. In "1 234 567,89" every group after the
 * first is exactly three digits and only the last carries a fraction; anything
 * else is two values that happen to be adjacent. Parts without digits are
 * trailing prose and are ignored.
 */
function holdsMultipleAmounts(text: string): boolean {
  const parts = text
    .replace(/(EUR|€|USD|\$|GBP|£|CHF)/gi, "")
    .replace(/^\s*([-+])\s*/, "$1") // a sign detached from its digits
    .trim()
    .split(/\s+/)
    .filter((p) => /\d/.test(p));
  if (parts.length < 2) return false;
  return parts.some((p, i) => {
    if (i === 0) return !/^[-+]?\d{1,3}$/.test(p);
    return i === parts.length - 1 ? !/^\d{3}([.,]\d{1,4})?$/.test(p) : !/^\d{3}$/.test(p);
  });
}

/**
 * Parse a rendered amount to a dot-decimal string. `decimal` pins the locale
 * (from a vendor template); otherwise it is auto-detected per value.
 */
export function parseAmount(text: string, decimal?: DecimalSeparator): string | null {
  if (holdsMultipleAmounts(text)) return null;
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
