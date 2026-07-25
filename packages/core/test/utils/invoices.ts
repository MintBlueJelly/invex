import type { CanonicalInvoice } from "../../src/schema/invoice";

/**
 * Minimal valid canonical invoices for unit tests. Deliberately hand-written and
 * NOT derived from packages/fixtures' computeInvoice — a test whose expectation
 * is produced by the same arithmetic it is checking proves nothing.
 */

export function invoice(patch: Partial<CanonicalInvoice> = {}): CanonicalInvoice {
  return {
    schemaVersion: 1,
    invoiceNumber: "R-2026-0042",
    issueDate: "2026-06-15",
    dueDate: null,
    currency: "EUR",
    locale: null,
    seller: {
      name: "ACME Bürotechnik GmbH",
      ustIdNr: "DE811907980",
      steuernummer: null,
      ibans: [],
      address: { street: null, postalCode: "80331", city: "München", countryCode: "DE" },
    },
    buyer: null,
    totals: { net: "1148.70", tax: "218.25", gross: "1366.95" },
    vatBreakdown: [{ rate: 19, net: "1148.70", tax: "218.25" }],
    lineItems: [
      {
        position: 1,
        description: "Aktenvernichter PS-500",
        quantity: "2",
        unit: null,
        unitPrice: "199.50",
        taxRate: 19,
        lineTotal: "399.00",
      },
    ],
    paymentTerms: null,
    ...patch,
  };
}
