import type { CanonicalInvoice } from "@invex/core";
import { vendorTemplates } from "../../../src/db/schema";
import { describe, expect, makeItShared } from "../../utils/fixture";
import { seedDocument } from "../../utils/testEnv";

/**
 * INVEX-004 — PUT /api/review/:id must not commit arithmetic nonsense.
 *
 * The handler validated with zCanonicalInvoice, which is a plain z.object with
 * no refinements: it checks that "999999.00" is a money-shaped string, never
 * that net + tax = gross. It then induced a VENDOR TEMPLATE from those numbers,
 * so a single typo in review anchored the wrong values for every future invoice
 * from that vendor. The one place a human's mistake is amplified rather than
 * contained.
 */

const it = makeItShared();

function correction(patch: Partial<CanonicalInvoice> = {}): CanonicalInvoice {
  return {
    schemaVersion: 1,
    invoiceNumber: "R-2026-0042",
    issueDate: "2026-06-15",
    dueDate: null,
    currency: "EUR",
    locale: "de-DE",
    seller: {
      name: "ACME Bürotechnik GmbH",
      ustIdNr: "DE811907980",
      steuernummer: null,
      ibans: [],
      address: { street: null, postalCode: "80331", city: "München", countryCode: "DE" },
    },
    buyer: null,
    totals: { net: "1000.00", tax: "190.00", gross: "1190.00" },
    vatBreakdown: [{ rate: 19, net: "1000.00", tax: "190.00" }],
    lineItems: [
      {
        position: 1,
        description: "Wartungsvertrag",
        quantity: "1",
        unit: null,
        unitPrice: "1000.00",
        taxRate: 19,
        lineTotal: "1000.00",
      },
    ],
    paymentTerms: null,
    ...patch,
  };
}

async function pendingReview(env: { db: Parameters<typeof seedDocument>[0] }): Promise<string> {
  return seedDocument(env.db, {
    filename: "review.pdf",
    status: "pending_review",
    route: "text",
    violations: [{ constraint: "C1_TOTALS", paths: ["totals"], detail: "net + tax != gross" }],
  });
}

describe("PUT /api/review/:id — arithmetic gate", () => {
  it("commits a correction whose numbers reconcile", async ({ env }) => {
    const id = await pendingReview(env);
    const res = await env.app.inject({ method: "PUT", url: `/api/review/${id}`, payload: correction() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ documentId: id, status: "committed" });
  });

  it("rejects a correction where net + tax != gross", async ({ env }) => {
    const id = await pendingReview(env);
    const res = await env.app.inject({
      method: "PUT",
      url: `/api/review/${id}`,
      payload: correction({ totals: { net: "1000.00", tax: "190.00", gross: "999999.00" } }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().violations.map((v: { constraint: string }) => v.constraint)).toContain("C1_TOTALS");
  });

  it("leaves the document in pending_review when the correction is rejected", async ({ env }) => {
    const id = await pendingReview(env);
    await env.app.inject({
      method: "PUT",
      url: `/api/review/${id}`,
      payload: correction({ totals: { net: "1000.00", tax: "190.00", gross: "999999.00" } }),
    });

    const doc = await env.app.inject({ method: "GET", url: `/api/documents/${id}` });
    expect(doc.json().status).toBe("pending_review");
  });

  it("does NOT induce a vendor template from a rejected correction", async ({ env }) => {
    // The reason this is critical rather than cosmetic: a template persists and
    // is reused, so a bad commit poisons the vendor, not just the document.
    const id = await pendingReview(env);
    await env.app.inject({
      method: "PUT",
      url: `/api/review/${id}`,
      payload: correction({ totals: { net: "1000.00", tax: "190.00", gross: "999999.00" } }),
    });

    expect(await env.db.select().from(vendorTemplates)).toHaveLength(0);
  });

  it("rejects line items that do not sum to the net total", async ({ env }) => {
    const id = await pendingReview(env);
    const res = await env.app.inject({
      method: "PUT",
      url: `/api/review/${id}`,
      payload: correction({
        lineItems: [
          { position: 1, description: "Wartungsvertrag", quantity: "1", unit: null, unitPrice: "42.00", taxRate: 19, lineTotal: "42.00" },
        ],
      }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().violations.map((v: { constraint: string }) => v.constraint)).toContain("C2_LINE_SUM");
  });

  it("allows a VAT rate outside the German closed set", async ({ env }) => {
    // C5 is a plausibility heuristic tuned for DE (19/7/0), not arithmetic. A
    // reviewer looking at an Austrian 20% invoice is the authority; blocking
    // them would make the gate worse than the bug. They may assert an unusual
    // rate — they may not assert that the totals contradict each other.
    const id = await pendingReview(env);
    const res = await env.app.inject({
      method: "PUT",
      url: `/api/review/${id}`,
      payload: correction({
        totals: { net: "1000.00", tax: "200.00", gross: "1200.00" },
        vatBreakdown: [{ rate: 20, net: "1000.00", tax: "200.00" }],
        lineItems: [
          { position: 1, description: "Wartungsvertrag", quantity: "1", unit: null, unitPrice: "1000.00", taxRate: 20, lineTotal: "1000.00" },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
  });

  it("still rejects a malformed body with 400, not 422", async ({ env }) => {
    const id = await pendingReview(env);
    const res = await env.app.inject({
      method: "PUT",
      url: `/api/review/${id}`,
      payload: correction({ invoiceNumber: "" }),
    });

    expect(res.statusCode).toBe(400);
  });
});
