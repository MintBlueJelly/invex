/**
 * Vendor-identifier validation (briefing §3): identifiers are only trusted for
 * template resolution when their checksums verify — a misOCRed USt-IdNr or IBAN
 * must not resolve to the wrong vendor's template.
 */

/**
 * German USt-IdNr: "DE" + 9 digits, ISO 7064 MOD 11,10 over the first 8 digits.
 */
export function isValidUstIdNr(value: string): boolean {
  const v = value.replace(/\s+/g, "").toUpperCase();
  const m = /^DE(\d{9})$/.exec(v);
  if (!m) return false;
  const digits = m[1]!;
  let product = 10;
  for (let i = 0; i < 8; i++) {
    let sum = (Number(digits[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  let check = 11 - product;
  if (check === 10) check = 0;
  return check === Number(digits[8]);
}

/** Normalize an IBAN to compact uppercase form. */
export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** ISO 13616 mod-97 check, via BigInt. */
export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric = "";
  for (const ch of rearranged) {
    numeric += /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
  }
  return BigInt(numeric) % 97n === 1n;
}

/**
 * German Steuernummer: NO nationwide checksum exists (formats vary by
 * Bundesland) — format plausibility only. It is therefore a weaker vendor key.
 */
export function isPlausibleSteuernummer(value: string): boolean {
  const v = value.trim();
  return /^\d{2,3}\/\d{3,4}\/\d{4,5}$/.test(v) || /^\d{10,13}$/.test(v);
}

/**
 * Last-resort vendor key: normalized name + postal code hash (FNV-1a 32-bit).
 * Strips legal forms and punctuation so "ACME GmbH & Co. KG" ≈ "acme".
 */
export function vendorNameHash(name: string, postalCode?: string | null): string {
  const normalized = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(gmbh|mbh|ag|kg|ohg|ug|se|e\.?\s?k\.?|co|inc|ltd|llc|haftungsbeschrankt)\b/g, " ")
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]/g, "");
  const input = `${normalized}|${(postalCode ?? "").trim()}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
