import { describe, expect, it } from "vitest";
import { diffCanonical } from "../../src/scripts/batchIngest";

/**
 * The field-level diff behind `pnpm smoke --strict-canonical`.
 *
 * Without it the smoke harness compared the gross total and the line COUNT and
 * nothing else — so an extraction with the right total and the wrong
 * descriptions, unit prices or VAT rows passed cleanly. The value of a diff is
 * that it names the path, so a failing run tells you which field moved rather
 * than that two large objects are unequal.
 */

describe("diffCanonical", () => {
  it("reports nothing for identical objects", () => {
    const inv = { totals: { net: "100.00", tax: "19.00" }, lineItems: [{ description: "A" }] };
    expect(diffCanonical(inv, structuredClone(inv))).toEqual([]);
  });

  it("names the dotted path of a changed scalar", () => {
    const diffs = diffCanonical({ totals: { net: "100.00" } }, { totals: { net: "999.00" } });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("totals.net");
    expect(diffs[0]).toContain("999.00");
  });

  it("indexes into arrays", () => {
    const diffs = diffCanonical(
      { lineItems: [{ lineTotal: "10.00" }, { lineTotal: "20.00" }] },
      { lineItems: [{ lineTotal: "10.00" }, { lineTotal: "99.00" }] },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("lineItems.1.lineTotal");
  });

  it("reports a length mismatch and still compares the overlap", () => {
    const diffs = diffCanonical({ lineItems: [{ d: "A" }, { d: "B" }] }, { lineItems: [{ d: "X" }] });
    expect(diffs.some((d) => d.includes("expected 2 entries, got 1"))).toBe(true);
    expect(diffs.some((d) => d.includes("lineItems.0.d"))).toBe(true);
  });

  it("distinguishes null from a missing key", () => {
    // "nullable is not the same as optional" (docs/api.md) — a dropped dueDate and an
    // explicit null are different extraction outcomes and must diff differently.
    expect(diffCanonical({ dueDate: null }, { dueDate: null })).toEqual([]);
    expect(diffCanonical({ dueDate: "2026-07-15" }, {})).toHaveLength(1);
  });

  it("reports a type change rather than silently comparing shapes", () => {
    expect(diffCanonical({ v: [1] }, { v: { "0": 1 } })[0]).toContain("expected an array");
    expect(diffCanonical({ v: { a: 1 } }, { v: "x" })[0]).toContain("expected an object");
  });

  it("collects every difference, not just the first", () => {
    const diffs = diffCanonical(
      { totals: { net: "1.00", tax: "2.00", gross: "3.00" } },
      { totals: { net: "9.00", tax: "9.00", gross: "9.00" } },
    );
    expect(diffs).toHaveLength(3);
  });
});
