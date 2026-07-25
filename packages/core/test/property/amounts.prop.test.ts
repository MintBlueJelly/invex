import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseAmount, renderAmount } from "../../src/index";
import { arbMoney } from "../utils/arbitraries";

/**
 * P1 and P2 — the two invariants that catch MAGNITUDE errors.
 *
 * Examples are good at "is this value right"; properties are good at "can this
 * function ever be wrong by 100x". Both defects these pin were real: INVEX-001
 * (a mis-detected separator multiplying a vendor's amounts by 100, permanently)
 * and INVEX-003 (two merged table cells fused into one plausible number). A
 * round trip is where that class of bug is cheap to find and expensive to spot
 * any other way.
 */

const SEPARATORS = [",", "."] as const;

describe("P1 — parseAmount is the inverse of renderAmount under a pinned locale", () => {
  it("round-trips every amount in both locales, grouped and ungrouped", () => {
    fc.assert(
      fc.property(arbMoney(), fc.constantFrom(...SEPARATORS), fc.boolean(), (dot, sep, grouped) => {
        expect(parseAmount(renderAmount(dot, sep, grouped), sep)).toBe(dot);
      }),
    );
  });

  it("never returns a value off by a factor of ten or more", () => {
    // The specific shape of INVEX-001: the value stayed numeric and plausible,
    // so nothing downstream could tell it was wrong. Stated as a property, a
    // separator confusion cannot hide.
    fc.assert(
      fc.property(arbMoney({ min: 1 }), fc.constantFrom(...SEPARATORS), fc.boolean(), (dot, sep, grouped) => {
        const parsed = parseAmount(renderAmount(dot, sep, grouped), sep);
        expect(parsed).not.toBeNull();
        const ratio = Number(parsed) / Number(dot);
        expect(ratio).toBeGreaterThan(0.999);
        expect(ratio).toBeLessThan(1.001);
      }),
    );
  });

  it("auto-detection agrees with the pinned locale whenever the rendering is unambiguous", () => {
    fc.assert(
      fc.property(arbMoney({ min: 0.01 }), fc.constantFrom(...SEPARATORS), (dot, sep) => {
        const rendered = renderAmount(dot, sep, true);
        // Grouped renderings carry both separators, so they are self-describing.
        fc.pre(rendered.includes(",") && rendered.includes("."));
        expect(parseAmount(rendered)).toBe(dot);
      }),
    );
  });
});

describe("P2 — parseAmount declines input holding more than one amount", () => {
  it("refuses two adjacent rendered amounts rather than fusing them", () => {
    // Exactly what an OCR column-band error produces (INVEX-002 -> INVEX-003).
    // The failure mode that made it dangerous was that the fused digits parsed
    // to a schema-valid number, so declining is the only safe answer.
    fc.assert(
      fc.property(arbMoney({ min: 1 }), arbMoney({ min: 1 }), fc.constantFrom(...SEPARATORS), (a, b, sep) => {
        const merged = `${renderAmount(a, sep, true)} ${renderAmount(b, sep, true)}`;
        expect(parseAmount(merged, sep)).toBeNull();
      }),
    );
  });

  it("still accepts a single space-grouped amount", () => {
    // The counter-property: declining must not become "refuse anything with a
    // space", or French/Swiss-style grouping would stop parsing.
    fc.assert(
      fc.property(arbMoney({ min: 1000 }), (dot) => {
        const spaceGrouped = renderAmount(dot, ",", true).replace(/\./g, " ");
        expect(parseAmount(spaceGrouped, ",")).toBe(dot);
      }),
    );
  });
});
