import { describe, expect, it } from "vitest";
import { knownBug } from "../../../../../test-utils/knownBug";
import { runRuleEngine } from "../../../src/index";
import { doc, line } from "../../utils/positionedBuilders";

/**
 * The generic rule engine — the lane EVERY first-seen vendor takes, and which
 * had zero tests. Phase 1 fills this out; what is here now is the pair that
 * validates the known-bug machinery end to end.
 */

describe("runRuleEngine — invoice number", () => {
  it("reads a properly labelled invoice number", () => {
    const d = doc([line("Rechnungsnummer R-2026-0042", { y: 0.1 })]);
    expect(runRuleEngine(d).envelope.invoice.invoiceNumber).toBe("R-2026-0042");
  });

  it("[current] a bare 'Rechnung' label captures the date as the invoice number", () => {
    // Records today's behaviour so a refactor to a THIRD wrong answer is caught
    // even while the pin below still "passes". See lexicon.ts:31 — bare
    // "Rechnung" is an invoiceNumber label, and the valuePattern accepts dots.
    const d = doc([line("Rechnung 12.06.2026", { y: 0.1 })]);
    expect(runRuleEngine(d).envelope.invoice.invoiceNumber).toBe("12.06.2026");
  });

  knownBug("INVEX-012", "bare 'Rechnung' is an invoiceNumber label and the pattern accepts dots")
    .it("does not mistake a date for an invoice number", () => {
      const d = doc([line("Rechnung 12.06.2026", { y: 0.1 })]);
      expect(runRuleEngine(d).envelope.invoice.invoiceNumber).not.toBe("12.06.2026");
    });
});
