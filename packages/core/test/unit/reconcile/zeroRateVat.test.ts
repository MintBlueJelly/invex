import { describe, expect, it } from "vitest";
import { reconcile } from "../../../src/index";
import type { ExtractionEnvelope } from "../../../src/schema/candidate";

/**
 * INVEX-010 — a 0 % VAT entry must be completable.
 *
 * The rule engine emits {rate, tax, net: null} for every VAT line it finds, so
 * completing `net` is the normal path. The guard `v.rate > 0` skipped rate 0,
 * which is not an edge case in Germany: it is every Kleinunternehmer invoice
 * (§19 UStG) and every reverse-charge invoice (§13b) — exactly the population
 * briefing §3 singles out when it lists Steuernummer as a vendor identifier
 * "because it covers Kleinunternehmer without USt-IdNr". Those documents could
 * never reconcile and always escalated.
 */

function envelope(rate: number, tax: string): ExtractionEnvelope {
  return {
    invoice: {
      invoiceNumber: "R-2026-0042",
      issueDate: "2026-06-15",
      currency: "EUR",
      seller: { name: "Kleinunternehmer Meier" },
      totals: { net: "1000.00", tax, gross: (1000 + Number(tax)).toFixed(2) },
      // The shape runRuleEngine produces: rate and tax found, net not.
      vatBreakdown: [{ rate, net: null, tax }],
      lineItems: [
        { description: "Beratung", quantity: "1", unitPrice: "1000.00", lineTotal: "1000.00", taxRate: rate },
      ],
    },
    fieldMeta: {},
  };
}

describe("R_VAT_SYNTH — completing a partial VAT entry", () => {
  it("completes net for a 19 % entry", () => {
    const r = reconcile(envelope(19, "190.00"));
    expect(r.status).toBe("reconciled");
    expect(r.invoice?.vatBreakdown).toEqual([{ rate: 19, net: "1000.00", tax: "190.00" }]);
  });

  it("completes net for a 0 % entry (§19 Kleinunternehmer / §13b reverse charge)", () => {
    const r = reconcile(envelope(0, "0.00"));
    expect(r.status).toBe("reconciled");
    expect(r.invoice?.vatBreakdown).toEqual([{ rate: 0, net: "1000.00", tax: "0.00" }]);
  });

  it("records the repair so the inference is auditable", () => {
    const r = reconcile(envelope(0, "0.00"));
    expect(r.repairs.map((x) => x.rule)).toContain("R_VAT_SYNTH");
  });

  it("does not invent a net for a 0 % entry when the totals give no basis", () => {
    // Guard against over-correcting: with no header net there is nothing to
    // apportion, and the document should still escalate rather than guess.
    const r = reconcile({
      invoice: {
        invoiceNumber: "R-1",
        issueDate: "2026-06-15",
        currency: "EUR",
        seller: { name: "X" },
        vatBreakdown: [{ rate: 0, net: null, tax: "0.00" }],
      },
      fieldMeta: {},
    });
    expect(r.status).toBe("failed");
  });
});
