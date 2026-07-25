import { classify, type ClassifierConfigCore } from "@invex/core";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";

/**
 * The committed classifier weights must actually reach the classifier.
 *
 * `config.ts` types weights as `z.record(z.string(), z.number())` and
 * `classifier.ts` looks them up with `?? 0`, so a renamed or misspelled feature
 * key silently contributes nothing and the classifier degrades with no error
 * (INVEX-020, pinned in core). Until that guard exists in production code, this
 * test is what notices — and it belongs here rather than in core, which is
 * deliberately I/O-free and has no node types.
 */

describe("config/classifier.json", () => {
  it("declares a weight for every feature the classifier scores", () => {
    // Black-box probe: classify() populates `features` with every known key
    // regardless of the weights passed in, so this reads the feature-name set
    // without reaching into classifier internals.
    const probe = classify(
      { pageCount: 1, lines: [], tables: [] },
      { weights: {}, bands: { invoiceMin: 999, nonInvoiceMax: -999 } },
    );
    const featureNames = Object.keys(probe.features);
    expect(featureNames.length).toBeGreaterThan(0);

    const committed = loadConfig({}).classifier as ClassifierConfigCore;
    for (const name of featureNames) {
      expect(Object.keys(committed.weights), `weight missing for ${name}`).toContain(name);
    }
  });

  it("declares no weight for a feature the classifier does not score", () => {
    // The other direction: a stale key left behind after a rename is dead
    // calibration data and misleads whoever tunes it next.
    const probe = classify(
      { pageCount: 1, lines: [], tables: [] },
      { weights: {}, bands: { invoiceMin: 999, nonInvoiceMax: -999 } },
    );
    const committed = loadConfig({}).classifier as ClassifierConfigCore;
    expect(Object.keys(committed.weights).sort()).toEqual(Object.keys(probe.features).sort());
  });

  it("keeps the bands ordered so the uncertain band exists", () => {
    const { bands } = loadConfig({}).classifier;
    expect(bands.invoiceMin).toBeGreaterThan(bands.nonInvoiceMax + 1);
  });
});
