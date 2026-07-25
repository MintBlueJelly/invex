import { describe, expect, it } from "vitest";
import { parseAmount, renderAmount } from "../../../src/index";

/**
 * INVEX-003 — parseAmount must decline ambiguous input rather than invent a
 * plausible number.
 *
 * When a layout error merges two table cells, the text arriving here is
 * "199,50 399,00". Stripping whitespace fuses it into 19950399.00: schema-valid,
 * arithmetically ordinary, and unrecognisable as wrong by any downstream
 * constraint. Returning null instead turns a silent corruption into a missing
 * field, which the solver reports.
 */

describe("parseAmount — single amounts", () => {
  it.each([
    ["1.234,56", ",", "1234.56"],
    ["1234,56", ",", "1234.56"],
    ["1,234.56", ".", "1234.56"],
    ["1234.56", ".", "1234.56"],
    ["0,00", ",", "0.00"],
    ["199,50 EUR", ",", "199.50"],
    ["€ 1.366,95", ",", "1366.95"],
    ["-1.234,56", ",", "-1234.56"],
  ])("parses %s with decimal %s", (text, sep, expected) => {
    expect(parseAmount(text, sep as "," | ".")).toBe(expected);
  });

  it("auto-detects the separator when none is pinned", () => {
    expect(parseAmount("1.234,56")).toBe("1234.56");
    expect(parseAmount("1,234.56")).toBe("1234.56");
  });

  it("round-trips through renderAmount under a pinned locale", () => {
    for (const value of ["1234.56", "0.00", "199.50", "1000000.01"]) {
      for (const sep of [",", "."] as const) {
        for (const grouped of [true, false]) {
          expect(parseAmount(renderAmount(value, sep, grouped), sep)).toBe(value);
        }
      }
    }
  });
});

describe("parseAmount — space-grouped numbers stay valid", () => {
  it.each([
    ["1 234,56", ",", "1234.56"],
    ["1 234 567,89", ",", "1234567.89"],
    ["12 345,00", ",", "12345.00"],
    ["1 234.56", ".", "1234.56"],
  ])("accepts %s as a single grouped amount", (text, sep, expected) => {
    expect(parseAmount(text, sep as "," | ".")).toBe(expected);
  });

  it("ignores trailing prose after the amount", () => {
    expect(parseAmount("1.148,70 netto", ",")).toBe("1148.70");
    expect(parseAmount("1.366,95 brutto", ",")).toBe("1366.95");
  });

  it("[current] trailing prose containing a period defeats the parse", () => {
    // stripNoise() keeps the "." from "inkl." and appends it to the fraction,
    // which then fails the 1-4 digit check. Fails SAFE (null, not a wrong
    // number), so it is recorded rather than fixed here.
    expect(parseAmount("1.366,95 inkl. MwSt", ",")).toBeNull();
  });
});

describe("parseAmount — refuses input holding more than one amount", () => {
  it("rejects two merged table cells rather than concatenating them", () => {
    // The exact string an OCR column-band error produces (INVEX-002).
    expect(parseAmount("199,50 399,00", ",")).toBeNull();
    expect(parseAmount("89,90 269,70", ",")).toBeNull();
    expect(parseAmount("1,234.56 5,678.90", ".")).toBeNull();
  });

  it("rejects a merged cell where the second value has no fraction", () => {
    expect(parseAmount("199,50 399", ",")).toBeNull();
  });

  it("rejects a rate fused with an amount", () => {
    // "MwSt 19% 218,25" — previously 19218.25.
    expect(parseAmount("19% 218,25", ",")).toBeNull();
  });

  it("rejects groups that are not three digits", () => {
    expect(parseAmount("1234 5678", ",")).toBeNull();
  });
});
