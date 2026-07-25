import { describe, expect, it } from "vitest";
import { reconcile } from "../src/index";
import type { CandidateInvoice, ExtractionEnvelope } from "../src/index";

function env(invoice: CandidateInvoice): ExtractionEnvelope {
  return { invoice, fieldMeta: {} };
}

/** A fully consistent single-rate invoice: 2 lines, 19% VAT. */
function consistentInvoice(): CandidateInvoice {
  return {
    invoiceNumber: "R-2026-0042",
    issueDate: "2026-06-15",
    currency: "EUR",
    seller: { name: "ACME GmbH", ustIdNr: "DE811907980", ibans: [] },
    totals: { net: "150.00", tax: "28.50", gross: "178.50" },
    vatBreakdown: [{ rate: 19, net: "150.00", tax: "28.50" }],
    lineItems: [
      { description: "Widget A", quantity: "2", unitPrice: "25.00", taxRate: 19, lineTotal: "50.00" },
      { description: "Service B", quantity: "4", unitPrice: "25.00", taxRate: 19, lineTotal: "100.00" },
    ],
  };
}

describe("reconcile — golden cases", () => {
  it("accepts a fully consistent invoice without repairs", () => {
    const r = reconcile(env(consistentInvoice()));
    expect(r.status).toBe("reconciled");
    expect(r.repairs).toHaveLength(0);
    expect(r.violations).toHaveLength(0);
    expect(r.invoice?.totals.gross).toBe("178.50");
  });

  it("R_QTY_DEFAULT: missing quantity defaults to 1 when unitPrice × 1 = lineTotal", () => {
    const c = consistentInvoice();
    c.lineItems = [
      { description: "Flat fee", unitPrice: "150.00", taxRate: 19, lineTotal: "150.00" },
    ];
    const r = reconcile(env(c));
    expect(r.status).toBe("reconciled");
    expect(r.repairs).toContainEqual({ rule: "R_QTY_DEFAULT", path: "lineItems.0.quantity", to: "1" });
    expect(r.invoice?.lineItems[0]?.quantity).toBe("1");
  });

  it("R_QTY_DERIVE: missing quantity is derived from lineTotal ÷ unitPrice", () => {
    const c = consistentInvoice();
    c.lineItems = [
      { description: "Widget A", unitPrice: "25.00", taxRate: 19, lineTotal: "50.00" },
      { description: "Service B", quantity: "4", unitPrice: "25.00", taxRate: 19, lineTotal: "100.00" },
    ];
    const r = reconcile(env(c));
    expect(r.status).toBe("reconciled");
    expect(r.invoice?.lineItems[0]?.quantity).toBe("2");
  });

  it("R_UNITPRICE_DERIVE: missing unitPrice = lineTotal ÷ quantity", () => {
    const c = consistentInvoice();
    c.lineItems![0] = { description: "Widget A", quantity: "2", taxRate: 19, lineTotal: "50.00" };
    const r = reconcile(env(c));
    expect(r.status).toBe("reconciled");
    expect(r.invoice?.lineItems[0]?.unitPrice).toBe("25");
  });

  it("R_LINETOTAL_DERIVE: missing lineTotal = quantity × unitPrice", () => {
    const c = consistentInvoice();
    c.lineItems![1] = { description: "Service B", quantity: "4", unitPrice: "25.00", taxRate: 19 };
    const r = reconcile(env(c));
    expect(r.status).toBe("reconciled");
    expect(r.invoice?.lineItems[1]?.lineTotal).toBe("100.00");
  });

  it("R_TOTAL_DERIVE + R_VAT_SYNTH: tax and breakdown reconstructed from net/gross", () => {
    const c = consistentInvoice();
    c.totals = { net: "150.00", gross: "178.50" };
    c.vatBreakdown = [];
    const r = reconcile(env(c));
    expect(r.status).toBe("reconciled");
    expect(r.invoice?.totals.tax).toBe("28.50");
    expect(r.invoice?.vatBreakdown).toEqual([{ rate: 19, net: "150.00", tax: "28.50" }]);
    expect(r.repairs.map((x) => x.rule)).toEqual(
      expect.arrayContaining(["R_TOTAL_DERIVE", "R_VAT_SYNTH"]),
    );
  });

  it("R_LINE_TAX_INHERIT: single-rate documents inherit the rate onto lines", () => {
    const c = consistentInvoice();
    c.lineItems = c.lineItems!.map((l) => ({ ...l, taxRate: null }));
    const r = reconcile(env(c));
    expect(r.status).toBe("reconciled");
    expect(r.invoice?.lineItems.every((l) => l.taxRate === 19)).toBe(true);
  });

  it("multi-rate + missing line rates escalates with LINE_TAX_UNRESOLVED (user decision)", () => {
    const c: CandidateInvoice = {
      invoiceNumber: "R-1", issueDate: "2026-01-01", currency: "EUR",
      seller: { name: "Mixed GmbH", ibans: [] },
      totals: { net: "200.00", tax: "26.00", gross: "226.00" },
      vatBreakdown: [
        { rate: 19, net: "100.00", tax: "19.00" },
        { rate: 7, net: "100.00", tax: "7.00" },
      ],
      lineItems: [
        { description: "Hardware", quantity: "1", unitPrice: "100.00", lineTotal: "100.00" },
        { description: "Book", quantity: "1", unitPrice: "100.00", lineTotal: "100.00" },
      ],
    };
    const r = reconcile(env(c));
    expect(r.status).toBe("failed");
    expect(r.violations.some((v) => v.constraint === "LINE_TAX_UNRESOLVED")).toBe(true);
    expect(r.totalFailure).toBe(false); // arithmetic itself closes
  });

  it("C2 failure with Σ(lines) ≈ gross records the lines_may_be_gross hint", () => {
    const c = consistentInvoice();
    // Lines printed as gross: 59.50 + 119.00 = 178.50 = gross
    c.lineItems = [
      { description: "Widget A", quantity: "1", unitPrice: "59.50", taxRate: 19, lineTotal: "59.50" },
      { description: "Service B", quantity: "1", unitPrice: "119.00", taxRate: 19, lineTotal: "119.00" },
    ];
    const r = reconcile(env(c));
    expect(r.status).toBe("failed");
    const c2 = r.violations.find((v) => v.constraint === "C2_LINE_SUM");
    expect(c2?.hint).toBe("lines_may_be_gross");
  });

  it("flat mismatch fails with C1/C2 violations and deltas", () => {
    const c = consistentInvoice();
    c.totals = { net: "150.00", tax: "28.50", gross: "200.00" };
    const r = reconcile(env(c));
    expect(r.status).toBe("failed");
    const v = r.violations.find((x) => x.constraint === "C1_TOTALS");
    expect(v?.delta).toBe("-21.50");
  });

  it("totalFailure: nothing reconciles at all (reclassification signal §5)", () => {
    const c: CandidateInvoice = {
      invoiceNumber: "X", issueDate: "2026-01-01",
      seller: { name: "??", ibans: [] },
      totals: { net: "100.00", tax: "50.00", gross: "poison" as string },
      lineItems: [{ description: "??", quantity: "3", unitPrice: "5.00", lineTotal: "99.00" }],
    };
    const r = reconcile(env(c));
    expect(r.status).toBe("failed");
    expect(r.totalFailure).toBe(true);
  });

  it("C5: off-set VAT rate is rejected", () => {
    const c = consistentInvoice();
    c.vatBreakdown = [{ rate: 16, net: "150.00", tax: "24.00" }];
    c.totals = { net: "150.00", tax: "24.00", gross: "174.00" };
    c.lineItems = c.lineItems!.map((l) => ({ ...l, taxRate: 16 }));
    const r = reconcile(env(c));
    expect(r.status).toBe("failed");
    expect(r.violations.some((v) => v.constraint === "C5_VAT_CLOSED_SET")).toBe(true);
  });

  it("tolerates rounding within ±0.02 on header constraints", () => {
    const c = consistentInvoice();
    c.totals = { net: "150.00", tax: "28.51", gross: "178.50" }; // 1 cent off
    c.vatBreakdown = [{ rate: 19, net: "150.00", tax: "28.51" }];
    const r = reconcile(env(c));
    expect(r.status).toBe("reconciled");
  });

  it("missing required metadata escalates (REQUIRED_MISSING)", () => {
    const c = consistentInvoice();
    c.invoiceNumber = null;
    const r = reconcile(env(c));
    expect(r.status).toBe("failed");
    expect(r.violations.some((v) => v.constraint === "REQUIRED_MISSING" && v.paths[0] === "invoiceNumber")).toBe(true);
  });

  it("writes derived values back into the envelope with source 'derived'", () => {
    const c = consistentInvoice();
    c.totals = { net: "150.00", gross: "178.50" };
    const r = reconcile(env(c));
    expect(r.envelope.invoice.totals?.tax).toBe("28.50");
    expect(r.envelope.fieldMeta["totals.tax"]?.source).toBe("derived");
  });

  it("empty candidate fails WITHOUT totalFailure (extraction failure, not misclassification)", () => {
    const r = reconcile(env({}));
    expect(r.status).toBe("failed");
    expect(r.totalFailure).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
  });
});
