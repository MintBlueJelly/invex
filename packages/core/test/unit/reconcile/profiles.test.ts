import { describe, expect, it } from "vitest";
import { reconcile } from "../../../src/reconcile/solver";
import { documentProfiles, profileFor } from "../../../src/reconcile/profiles";
import { DOCUMENT_TYPES, type DocumentType } from "../../../src/schema/documentType";
import type { CandidateInvoice, ExtractionEnvelope } from "../../../src/schema/candidate";

const env = (invoice: CandidateInvoice): ExtractionEnvelope => ({ invoice, fieldMeta: {} });

/** A delivery note as printed: what was delivered, and not a single amount. */
function pricelessDeliveryNote(): CandidateInvoice {
  return {
    documentType: "deliveryNote",
    documentNumber: "LS-2026-0311",
    documentDate: "2026-09-18",
    seller: { name: "Nordlicht Maschinenbau GmbH", ustIdNr: "DE136695976", ibans: [] },
    lineItems: [
      { position: 1, description: "Hydraulikzylinder HZ-90", quantity: "4", unit: "Stk" },
      { position: 2, description: "Dichtungssatz für HZ-90", quantity: "4", unit: "Stk" },
    ],
  };
}

describe("documentProfiles", () => {
  it("covers every document class", () => {
    expect(Object.keys(documentProfiles).sort()).toEqual([...DOCUMENT_TYPES].sort());
  });

  it("requires amounts of every class except the delivery note", () => {
    for (const t of DOCUMENT_TYPES) {
      expect(profileFor(t).requireTotals, t).toBe(t !== "deliveryNote");
      expect(profileFor(t).requireVat, t).toBe(t !== "deliveryNote");
    }
  });

  it("requires line items of every class — they are the point of the document", () => {
    for (const t of DOCUMENT_TYPES) expect(profileFor(t).requireLineItems, t).toBe(true);
  });
});

describe("reconcile — per-class required fields", () => {
  it("a priceless delivery note reconciles, with null totals and no VAT", () => {
    const r = reconcile(env(pricelessDeliveryNote()));
    expect(r.violations).toEqual([]);
    expect(r.status).toBe("reconciled");
    expect(r.invoice?.documentType).toBe("deliveryNote");
    expect(r.invoice?.totals).toBeNull();
    expect(r.invoice?.vatBreakdown).toEqual([]);
    expect(r.invoice?.lineItems).toHaveLength(2);
  });

  // The relaxation must be scoped to the class, not to "amounts are missing".
  it("the SAME candidate as an invoice fails on totals and VAT", () => {
    const r = reconcile(env({ ...pricelessDeliveryNote(), documentType: "invoice" }));
    expect(r.status).toBe("failed");
    const constraints = r.violations.map((v) => v.constraint);
    expect(constraints).toContain("TOTALS_INCOMPLETE");
    expect(constraints).toContain("VAT_MISSING");
    // And the line-total gap is a gap again, because an invoice carries money.
    expect(constraints).toContain("LINE_TOTAL_UNRESOLVED");
  });

  it.each(["invoice", "creditNote", "orderConfirmation", "quote"] as DocumentType[])(
    "%s still requires totals and VAT",
    (documentType) => {
      const r = reconcile(env({ ...pricelessDeliveryNote(), documentType }));
      expect(r.status).toBe("failed");
      expect(r.violations.some((v) => v.constraint === "TOTALS_INCOMPLETE")).toBe(true);
    },
  );

  it("identity is required of every class, delivery notes included", () => {
    const c = pricelessDeliveryNote();
    c.documentNumber = null;
    const r = reconcile(env(c));
    expect(r.status).toBe("failed");
    expect(
      r.violations.some((v) => v.constraint === "REQUIRED_MISSING" && v.paths[0] === "documentNumber"),
    ).toBe(true);
  });

  it("an unknown class defaults to invoice, preserving pre-v2 behaviour", () => {
    const { documentType: _omitted, ...noType } = pricelessDeliveryNote();
    const r = reconcile(env(noType));
    expect(r.status).toBe("failed");
    expect(r.violations.some((v) => v.constraint === "TOTALS_INCOMPLETE")).toBe(true);
  });
});

describe("reconcile — a delivery note that DOES print amounts", () => {
  // The customs case. Relaxing the gate must not also disable the arithmetic:
  // once a document carries money, the money has to be right.
  const priced = (): CandidateInvoice => ({
    ...pricelessDeliveryNote(),
    totals: { net: "100.00", tax: "19.00", gross: "119.00" },
    vatBreakdown: [{ rate: 19, net: "100.00", tax: "19.00" }],
    lineItems: [
      { position: 1, description: "Hydraulikzylinder HZ-90", quantity: "4", unitPrice: "25.00", lineTotal: "100.00", taxRate: 19 },
    ],
  });

  it("reconciles when the arithmetic closes", () => {
    const r = reconcile(env(priced()));
    expect(r.violations).toEqual([]);
    expect(r.invoice?.totals).toEqual({ net: "100.00", tax: "19.00", gross: "119.00" });
  });

  it("still fails C1 when net + tax != gross", () => {
    const c = priced();
    c.totals = { net: "100.00", tax: "19.00", gross: "150.00" };
    const r = reconcile(env(c));
    expect(r.status).toBe("failed");
    expect(r.violations.some((v) => v.constraint === "C1_TOTALS")).toBe(true);
  });

  it("still fails C3 when quantity x unitPrice != lineTotal", () => {
    const c = priced();
    c.lineItems = [
      { position: 1, description: "Hydraulikzylinder HZ-90", quantity: "4", unitPrice: "25.00", lineTotal: "80.00", taxRate: 19 },
    ];
    const r = reconcile(env(c));
    expect(r.status).toBe("failed");
    expect(r.violations.some((v) => v.constraint === "C3_LINE_MATH")).toBe(true);
  });
});

/**
 * The three states arithmeticVerified exists to separate. Two booleans, three
 * meanings — and the third is what a priceless delivery note needs, because
 * without it "committed" says the same thing for a checked invoice and for a
 * document that had nothing to check.
 */
describe("arithmeticVerified — did the numbers actually corroborate each other", () => {
  it("false with totalFailure false: there were no numbers", () => {
    const r = reconcile(env(pricelessDeliveryNote()));
    expect(r.status).toBe("reconciled");
    expect(r.arithmeticVerified).toBe(false);
    expect(r.totalFailure).toBe(false);
  });

  it("true with totalFailure false: the numbers check out", () => {
    const r = reconcile(
      env({
        ...pricelessDeliveryNote(),
        totals: { net: "100.00", tax: "19.00", gross: "119.00" },
        vatBreakdown: [{ rate: 19, net: "100.00", tax: "19.00" }],
        lineItems: [
          { position: 1, description: "Zylinder", quantity: "4", unitPrice: "25.00", lineTotal: "100.00", taxRate: 19 },
        ],
      }),
    );
    expect(r.status).toBe("reconciled");
    expect(r.arithmeticVerified).toBe(true);
    expect(r.totalFailure).toBe(false);
  });

  it("false with totalFailure true: the numbers contradict each other", () => {
    const r = reconcile(
      env({
        ...pricelessDeliveryNote(),
        documentType: "invoice",
        totals: { net: "100.00", tax: "19.00", gross: "999.00" },
        vatBreakdown: [{ rate: 19, net: "100.00", tax: "77.00" }],
        lineItems: [
          { position: 1, description: "Zylinder", quantity: "4", unitPrice: "25.00", lineTotal: "500.00", taxRate: 19 },
        ],
      }),
    );
    expect(r.arithmeticVerified).toBe(false);
    expect(r.totalFailure).toBe(true);
  });

  // The property that makes the flag worth trusting: it is judged pre-repair,
  // so a constraint satisfied by a value the solver itself derived does not
  // count as corroboration.
  it("is NOT set by a constraint that only holds because a repair supplied its operand", () => {
    const r = reconcile(
      env({
        documentType: "invoice",
        documentNumber: "R-1",
        documentDate: "2026-06-15",
        seller: { name: "ACME GmbH", ibans: [] },
        // Net and gross are printed; tax is not, and no line total, VAT row or
        // unit price exists to corroborate them. Pre-repair NOTHING is
        // evaluable; R_TOTAL_DERIVE then computes tax = gross - net, after
        // which C1 holds by construction. That must not read as verified.
        totals: { net: "100.00", gross: "119.00" },
        lineItems: [{ position: 1, description: "Zylinder" }],
      }),
    );
    expect(r.repairs.length).toBeGreaterThan(0);
    expect(r.arithmeticVerified).toBe(false);
  });

  it("a delivery note that DOES print prices is verified like any invoice", () => {
    const r = reconcile(
      env({
        ...pricelessDeliveryNote(),
        totals: { net: "100.00", tax: "19.00", gross: "119.00" },
        vatBreakdown: [{ rate: 19, net: "100.00", tax: "19.00" }],
        lineItems: [
          { position: 1, description: "Zylinder", quantity: "4", unitPrice: "25.00", lineTotal: "100.00", taxRate: 19 },
        ],
      }),
    );
    expect(r.invoice?.documentType).toBe("deliveryNote");
    expect(r.arithmeticVerified).toBe(true);
  });
});

describe("reconcile — credit notes carry negative amounts without a sign rule", () => {
  it("reconciles a fully negative credit note", () => {
    const r = reconcile(
      env({
        documentType: "creditNote",
        documentNumber: "GS-2026-0018",
        documentDate: "2026-09-22",
        seller: { name: "Nordlicht Maschinenbau GmbH", ibans: [] },
        totals: { net: "-200.00", tax: "-38.00", gross: "-238.00" },
        vatBreakdown: [{ rate: 19, net: "-200.00", tax: "-38.00" }],
        lineItems: [
          { position: 1, description: "Rückgabe Dichtungssatz", quantity: "2", unitPrice: "-100.00", lineTotal: "-200.00", taxRate: 19 },
        ],
      }),
    );
    expect(r.violations).toEqual([]);
    expect(r.invoice?.totals?.gross).toBe("-238.00");
  });

  // Gutschriftverfahren (self-billing) prints positive amounts under the same
  // heading, so a sign rule would false-fail it. See profiles.ts.
  it("reconciles a positive credit note just as readily", () => {
    const r = reconcile(
      env({
        documentType: "creditNote",
        documentNumber: "GS-2026-0019",
        documentDate: "2026-09-22",
        seller: { name: "Nordlicht Maschinenbau GmbH", ibans: [] },
        totals: { net: "200.00", tax: "38.00", gross: "238.00" },
        vatBreakdown: [{ rate: 19, net: "200.00", tax: "38.00" }],
        lineItems: [
          { position: 1, description: "Provision", quantity: "1", unitPrice: "200.00", lineTotal: "200.00", taxRate: 19 },
        ],
      }),
    );
    expect(r.violations).toEqual([]);
    expect(r.invoice?.totals?.gross).toBe("238.00");
  });
});
