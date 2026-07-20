import type { PositionedTextDocument } from "../positioned/model";
import {
  isPlausibleSteuernummer,
  isValidIban,
  isValidUstIdNr,
  normalizeIban,
  vendorNameHash,
} from "./checksums";

/**
 * Vendor identifier extraction — runs on EVERY lane's positioned text (Docling
 * or OCR) BEFORE template lookup (briefing §3). Checksums gate what counts.
 */

export interface ExtractedVendorIds {
  ustIdNr: string | null;
  steuernummer: string | null;
  ibans: string[];
  nameGuess: string | null;
  postalCodeGuess: string | null;
  nameHash: string | null;
}

export function extractVendorIds(doc: PositionedTextDocument): ExtractedVendorIds {
  const texts = doc.lines.map((l) => l.text);
  const all = texts.join("\n");

  // USt-IdNr: DE + 9 digits (tolerate an internal space), checksum-verified.
  let ustIdNr: string | null = null;
  for (const m of all.matchAll(/\bDE\s?(\d[\d\s]{7,12}\d)\b/g)) {
    const candidate = `DE${m[1]!.replace(/\s+/g, "")}`;
    if (isValidUstIdNr(candidate)) {
      ustIdNr = candidate;
      break;
    }
  }

  // IBANs (possibly space-grouped), mod-97-verified; vendors may print several.
  const ibans: string[] = [];
  for (const m of all.matchAll(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{2,4}){3,8}\b/g)) {
    const compact = normalizeIban(m[0]);
    if (isValidIban(compact) && !ibans.includes(compact)) ibans.push(compact);
  }

  // Steuernummer: label-anchored only (the bare pattern is too collision-prone).
  let steuernummer: string | null = null;
  for (const line of texts) {
    if (!/steuernummer|steuer-?nr/i.test(line)) continue;
    const m = /(\d{2,3}\/\d{3,4}\/\d{4,5}|\d{10,13})/.exec(line);
    if (m && isPlausibleSteuernummer(m[1]!)) {
      steuernummer = m[1]!;
      break;
    }
  }

  // Letterhead heuristic: the vendor name is the topmost substantial line of
  // page 1; the postal code comes from the first nearby 5-digit token.
  const page1 = doc.lines
    .filter((l) => l.page === 1)
    .sort((a, b) => a.bbox[1] - b.bbox[1]);
  const nameGuess =
    page1.find((l) => l.text.trim().length >= 3 && !/^\d+$/.test(l.text.trim()))?.text.trim() ?? null;
  let postalCodeGuess: string | null = null;
  for (const line of page1.slice(0, 8)) {
    const m = /\b(\d{5})\b/.exec(line.text);
    if (m) {
      postalCodeGuess = m[1]!;
      break;
    }
  }

  return {
    ustIdNr,
    steuernummer,
    ibans,
    nameGuess,
    postalCodeGuess,
    nameHash: nameGuess ? vendorNameHash(nameGuess, postalCodeGuess) : null,
  };
}
