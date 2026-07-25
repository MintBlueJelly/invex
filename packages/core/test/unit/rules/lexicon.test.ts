import { describe, expect, it } from "vitest";
import { defaultLexicon } from "../../../src/index";
import { normalizeLabel } from "../../../src/positioned/model";

/**
 * Structural properties of the lexicon, independent of the engine that
 * consumes it. These guard the two ways an edit here breaks the rule engine
 * silently rather than loudly: an empty label (matches every line's
 * startsWith("")) and a malformed valuePattern (throws deep inside
 * findLabelHits on the FIRST document that reaches it, not at edit time).
 */

describe("defaultLexicon.header — shape", () => {
  it("declares exactly the six canonical fields engine.ts's setHeaderField switches on", () => {
    // setHeaderField has no default branch — a renamed/added key here would be
    // silently dropped by the switch rather than throwing.
    expect(Object.keys(defaultLexicon.header).sort()).toEqual(
      ["dueDate", "invoiceNumber", "issueDate", "totals.gross", "totals.net", "totals.tax"].sort(),
    );
  });

  it("every entry has a non-empty labels array with no empty label, and a compiling valuePattern", () => {
    for (const [key, entry] of Object.entries(defaultLexicon.header)) {
      expect(entry.labels.length, key).toBeGreaterThan(0);
      expect(entry.labels.every((l) => l.trim() !== ""), key).toBe(true);
      expect(() => new RegExp(entry.valuePattern ?? ""), key).not.toThrow();
    }
  });
});

describe("defaultLexicon.table — shape", () => {
  it("declares exactly the seven columns LineColumnKey expects, each with synonyms", () => {
    expect(Object.keys(defaultLexicon.table).sort()).toEqual(
      ["description", "lineTotal", "position", "quantity", "taxRate", "unit", "unitPrice"].sort(),
    );
    for (const [key, synonyms] of Object.entries(defaultLexicon.table)) {
      expect(synonyms.length, key).toBeGreaterThan(0);
      expect(synonyms.every((s) => s.trim() !== ""), key).toBe(true);
    }
  });
});

/**
 * Reimplements classifyColumns' own matching rule (engine.ts): exact match, or
 * a synonym of length >= 3 found ANYWHERE in the header cell. Used below to
 * enumerate every synonym pair that can steal a column from the wrong key —
 * the exact mechanism behind INVEX-018.
 */
function tableColumnCollisions() {
  const table = defaultLexicon.table;
  const keys = Object.keys(table) as (keyof typeof table)[];
  const collisions: { shortKey: string; short: string; longKey: string; long: string }[] = [];
  const seen = new Set<string>();
  for (const k1 of keys) {
    for (const k2 of keys) {
      if (k1 === k2) continue;
      for (const s1 of table[k1].map(normalizeLabel)) {
        if (s1.length < 3) continue;
        for (const s2 of table[k2].map(normalizeLabel)) {
          if (s2 === "" || s1 === s2 || !s2.includes(s1)) continue;
          const dedupeKey = `${k1}:${s1}|${k2}:${s2}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          collisions.push({ shortKey: k1, short: s1, longKey: k2, long: s2 });
        }
      }
    }
  }
  return collisions;
}

describe("defaultLexicon.table — cross-column synonym collisions", () => {
  const collisions = tableColumnCollisions();

  it("has exactly the known cross-column collisions today", () => {
    // A change here means a synonym was added or removed; re-check against
    // classifyColumns (src/rules/engine.ts) before updating this count —
    // don't just bump it to make the test pass.
    expect(collisions).toHaveLength(10);
  });

  it("includes 'Satz' (unitPrice) inside 'Steuersatz' (taxRate) — the INVEX-018 mechanism", () => {
    expect(collisions).toContainEqual({ shortKey: "unitPrice", short: "satz", longKey: "taxRate", long: "steuersatz" });
    expect(collisions).toContainEqual({ shortKey: "unitPrice", short: "satz", longKey: "taxRate", long: "mwstsatz" });
    expect(collisions).toContainEqual({ shortKey: "unitPrice", short: "satz", longKey: "taxRate", long: "stsatz" });
  });

  it("also collides unitPrice's 'Preis' into lineTotal's 'Gesamtpreis'", () => {
    // A "Gesamtpreis" column header would be claimed as unitPrice before
    // lineTotal ever gets a chance to look at it (unitPrice is not tried
    // first, but if lineTotal's own synonyms miss it first, this is the trap).
    expect(collisions).toContainEqual({ shortKey: "unitPrice", short: "preis", longKey: "lineTotal", long: "gesamtpreis" });
  });
});

/** Same idea as above, but for header labels: which shorter label is a substring of a longer one. */
function headerLabelCollisions() {
  const header = defaultLexicon.header;
  const keys = Object.keys(header) as (keyof typeof header)[];
  const all: { key: string; raw: string; norm: string }[] = [];
  for (const k of keys) for (const l of header[k].labels) all.push({ key: k, raw: l, norm: normalizeLabel(l) });
  const collisions: { shortKey: string; short: string; longKey: string; long: string }[] = [];
  for (const a of all) {
    for (const b of all) {
      if (a === b || a.norm === "") continue;
      if (a.norm !== b.norm && a.norm.length < b.norm.length && b.norm.includes(a.norm)) {
        collisions.push({ shortKey: a.key, short: a.raw, longKey: b.key, long: b.raw });
      }
    }
  }
  return collisions;
}

describe("defaultLexicon.header — cross-field label collisions", () => {
  const collisions = headerLabelCollisions();
  const crossField = collisions
    .filter((c) => c.shortKey !== c.longKey)
    .sort((a, b) => `${a.short}|${a.long}`.localeCompare(`${b.short}|${b.long}`));

  it("has exactly the known label collisions today (most within the same field, harmless)", () => {
    expect(collisions).toHaveLength(29);
  });

  it("has exactly these collisions ACROSS different fields — each is a genuine mislabel risk", () => {
    // Same-field collisions (e.g. "Netto" ⊂ "Nettobetrag") are harmless: either
    // label finding a line resolves to the same field. Cross-field ones can
    // steal a hit for the WRONG field when the longer label's own line is
    // absent — "Rechnung" ⊂ "Rechnungsdatum" is exactly INVEX-012's mechanism.
    expect(crossField).toEqual(
      [
        { shortKey: "invoiceNumber", short: "Invoice #", longKey: "issueDate", long: "Invoice Date" },
        { shortKey: "invoiceNumber", short: "Rechnung", longKey: "issueDate", long: "Rechnungsdatum" },
        { shortKey: "invoiceNumber", short: "Rechnung", longKey: "totals.gross", long: "Rechnungsbetrag" },
        { shortKey: "issueDate", short: "Date", longKey: "dueDate", long: "Due Date" },
        { shortKey: "issueDate", short: "Datum", longKey: "dueDate", long: "Fälligkeitsdatum" },
        { shortKey: "totals.gross", short: "Total", longKey: "totals.net", long: "Net Total" },
        { shortKey: "totals.gross", short: "Total", longKey: "totals.net", long: "Subtotal" },
      ].sort((a, b) => `${a.short}|${a.long}`.localeCompare(`${b.short}|${b.long}`)),
    );
  });
});

describe("defaultLexicon.header — valuePattern semantics", () => {
  it("the AMOUNT pattern (shared by all totals.* fields) accepts a signed, grouped dot-decimal number", () => {
    const pattern = new RegExp(defaultLexicon.header["totals.net"].valuePattern!);
    expect(pattern.exec("-1.234,56 EUR")?.[0]).toBe("-1.234,56");
  });

  it("the DATE pattern (shared by issueDate/dueDate) accepts d.M.yyyy but doesn't match free text", () => {
    const pattern = new RegExp(defaultLexicon.header.issueDate.valuePattern!);
    expect(pattern.exec("1.3.2026")?.[0]).toBe("1.3.2026");
    expect(pattern.test("banana")).toBe(false);
  });

  it("invoiceNumber's valuePattern requires a digit somewhere in the token", () => {
    const pattern = new RegExp(defaultLexicon.header.invoiceNumber.valuePattern!);
    expect(pattern.test("ABCDEF")).toBe(false);
    expect(pattern.test("RE-2026-0042")).toBe(true);
  });
});
