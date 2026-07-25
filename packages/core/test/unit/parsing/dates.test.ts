import { describe, expect, it } from "vitest";
import { DEFAULT_DATE_FORMATS, parseDateToIso, renderIsoDate } from "../../../src/index";
import { knownBug } from "../../../../../test-utils/knownBug";

/**
 * date-fns `parse` is called with no `locale` option (see src/parsing/dates.ts),
 * so every format token resolves against en-US names/abbreviations regardless
 * of how "German" the format string looks. That single fact drives most of the
 * surprises pinned below.
 */

describe("renderIsoDate → parseDateToIso round-trips every DEFAULT_DATE_FORMATS entry", () => {
  it.each(DEFAULT_DATE_FORMATS)("round-trips 2026-06-15 through %s", (fmt) => {
    const rendered = renderIsoDate("2026-06-15", fmt);
    expect(rendered).not.toBeNull();
    expect(parseDateToIso(rendered as string)).toBe("2026-06-15");
  });

  it("renders 'd. MMMM yyyy' and 'MMMM d, yyyy' with English month names, not German", () => {
    // The format string reads as a German-invoice pattern, but formatDate() is
    // locale-less too, so the "day. month year" shape round-trips only because
    // both sides silently agree on English — it never touches actual German text.
    expect(renderIsoDate("2026-06-15", "d. MMMM yyyy")).toBe("15. June 2026");
    expect(renderIsoDate("2026-06-15", "MMMM d, yyyy")).toBe("June 15, 2026");
  });
});

describe("parseDateToIso — direct format recognition", () => {
  it.each([
    ["15.06.2026", "2026-06-15"],
    ["2026-06-15", "2026-06-15"],
    ["15/06/2026", "2026-06-15"],
    ["June 15, 2026", "2026-06-15"],
    ["15.6.2026", "2026-06-15"],
    ["5.6.2026", "2026-06-05"],
  ])("parses %s", (text, expected) => {
    expect(parseDateToIso(text)).toBe(expected);
  });
});

describe("parseDateToIso — year window guard (1990-2100 inclusive)", () => {
  it.each([
    ["01.01.1989", null],
    ["01.01.1990", "1990-01-01"],
    ["01.01.2100", "2100-01-01"],
    ["01.01.2101", null],
  ])("%s -> %s", (text, expected) => {
    expect(parseDateToIso(text)).toBe(expected);
  });
});

describe("parseDateToIso — full-string matching", () => {
  it("rejects a leading label before the date", () => {
    // A real invoice line: "Rechnungsdatum 15.06.2026" — the field label must
    // already be stripped upstream, parseDateToIso will not do it silently.
    expect(parseDateToIso("Rechnungsdatum 15.06.2026")).toBeNull();
  });

  it("rejects a trailing time-of-day", () => {
    expect(parseDateToIso("15.06.2026 10:00")).toBeNull();
  });

  it("trims surrounding whitespace but still requires the rest to match fully", () => {
    expect(parseDateToIso("  15.06.2026  ")).toBe("2026-06-15");
  });
});

describe("parseDateToIso — ISO datetimes (CII / VLM output often carries a time component)", () => {
  it("[current] a bare date matches yyyy-MM-dd", () => {
    expect(parseDateToIso("2026-06-15")).toBe("2026-06-15");
  });

  it("[current] a full ISO datetime does not parse — no format in the list allows a time suffix", () => {
    // Neither "2026-06-15T10:00:00" nor a "Z"/offset variant match yyyy-MM-dd,
    // since that format requires the string to end at the day. Any CII/VLM field
    // that emits a timestamp instead of a bare date silently produces no match.
    expect(parseDateToIso("2026-06-15T10:00:00")).toBeNull();
    expect(parseDateToIso("2026-06-15T00:00:00Z")).toBeNull();
  });
});

describe("parseDateToIso — US-style month/day is not in the format list", () => {
  it("[current] MM/dd/yyyy input is misread as dd/MM/yyyy and rejected, not swapped", () => {
    // "06/15/2026" as dd/MM/yyyy would need month=15, which is invalid — it does
    // NOT fall back to a US interpretation, it just fails to parse.
    expect(parseDateToIso("06/15/2026")).toBeNull();
  });

  it("a genuinely day-first slash date still parses via dd/MM/yyyy", () => {
    expect(parseDateToIso("15/06/2026")).toBe("2026-06-15");
  });
});

describe("parseDateToIso — format-order ambiguity", () => {
  it("'1.2.2026' resolves day-first (dd.MM.yyyy is tried before any month-first format)", () => {
    expect(parseDateToIso("1.2.2026")).toBe("2026-02-01");
  });
});

describe("parseDateToIso — dd.MM.yy two-digit year", () => {
  it("[current] yy 00-49 and 90-99 land in a plausible century; 50-89 silently vanish", () => {
    // date-fns pivots yy around the fixed REFERENCE year (2000): 00-49 -> 20xx,
    // 50-99 -> 19xx. The 1990-2100 guard then keeps 90-99 (1990s) but discards
    // 50-89 (1950s-1980s) with no error — same input shape, opposite outcome.
    expect(parseDateToIso("01.02.03")).toBe("2003-02-01");
    expect(parseDateToIso("01.02.49")).toBe("2049-02-01");
    expect(parseDateToIso("01.02.99")).toBe("1999-02-01");
    expect(parseDateToIso("01.02.50")).toBeNull();
    expect(parseDateToIso("01.02.85")).toBeNull();
  });

  knownBug(
    "INVEX-031",
    "dd.MM.yy years 50-89 pivot to 1950-1989 and then fail the 1990-2100 guard, silently returning null",
  ).it("resolves a two-digit year in the 50-89 band instead of returning null", () => {
    expect(parseDateToIso("01.02.55")).toBe("2055-02-01");
  });
});

describe("parseDateToIso — German month names", () => {
  it("[current] a German month name never matches, even though 'd. MMMM yyyy' is in DEFAULT_DATE_FORMATS", () => {
    expect(parseDateToIso("15. Juni 2026")).toBeNull();
  });

  knownBug("INVEX-013", "German month names never parse — parse() is never given a locale").it(
    "parses a German-language long date",
    () => {
      expect(parseDateToIso("15. Juni 2026")).toBe("2026-06-15");
    },
  );
});

describe("parseDateToIso — empty and garbage input", () => {
  it.each([
    ["", null],
    ["   ", null],
    ["garbage", null],
    ["31.02.2026", null], // Feb 31 does not exist in any year
  ])("%s -> %s", (text, expected) => {
    expect(parseDateToIso(text)).toBe(expected);
  });
});

describe("renderIsoDate — invalid input", () => {
  it("returns null for a non-ISO string", () => {
    expect(renderIsoDate("not-a-date", "dd.MM.yyyy")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(renderIsoDate("", "dd.MM.yyyy")).toBeNull();
  });

  it("returns null for an out-of-range calendar date", () => {
    expect(renderIsoDate("2026-13-40", "dd.MM.yyyy")).toBeNull();
  });
});
