import { format as formatDate, isValid, parse } from "date-fns";

/**
 * Date normalization for the rule engine and template application. Formats are
 * date-fns tokens; a vendor template pins its own list (briefing §3 locale).
 */

export const DEFAULT_DATE_FORMATS = [
  "dd.MM.yyyy",
  "d.M.yyyy",
  "yyyy-MM-dd",
  "dd/MM/yyyy",
  "d. MMMM yyyy",
  "MMMM d, yyyy",
  "dd.MM.yy",
];

const REFERENCE = new Date(2000, 0, 1);

export function parseDateToIso(text: string, formats: string[] = DEFAULT_DATE_FORMATS): string | null {
  const s = text.trim();
  if (s === "") return null;
  for (const fmt of formats) {
    const d = parse(s, fmt, REFERENCE);
    if (isValid(d) && d.getFullYear() >= 1990 && d.getFullYear() <= 2100) {
      return formatDate(d, "yyyy-MM-dd");
    }
  }
  return null;
}

/** Render an ISO date in a given format (used by template induction search). */
export function renderIsoDate(iso: string, fmt: string): string | null {
  const d = parse(iso, "yyyy-MM-dd", REFERENCE);
  if (!isValid(d)) return null;
  return formatDate(d, fmt);
}
