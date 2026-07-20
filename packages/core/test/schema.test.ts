import { describe, expect, it } from "vitest";
import { toVlmJsonSchema, zCanonicalInvoice } from "../src/index";

describe("canonical schema", () => {
  it("round-trips a valid invoice", () => {
    const invoice = {
      schemaVersion: 1,
      invoiceNumber: "R-1",
      issueDate: "2026-06-15",
      dueDate: null,
      currency: "EUR",
      locale: "de-DE",
      seller: { name: "ACME GmbH", ustIdNr: "DE811907980", steuernummer: null, ibans: ["DE89370400440532013000"], address: null },
      buyer: null,
      totals: { net: "100.00", tax: "19.00", gross: "119.00" },
      vatBreakdown: [{ rate: 19, net: "100.00", tax: "19.00" }],
      lineItems: [
        { position: 1, description: "Widget", quantity: "1", unit: "Stk", unitPrice: "100.00", taxRate: 19, lineTotal: "100.00" },
      ],
      paymentTerms: null,
    };
    const parsed = zCanonicalInvoice.parse(invoice);
    expect(parsed).toEqual(invoice);
  });

  it("rejects float-ish money and empty descriptions", () => {
    expect(() => zCanonicalInvoice.shape.totals.parse({ net: "100.123", tax: "19.00", gross: "119.00" })).toThrow();
    expect(() => zCanonicalInvoice.shape.lineItems.element.shape.description.parse("")).toThrow();
  });

  it("derives a JSON schema for VLM constrained decoding", () => {
    const schema = toVlmJsonSchema();
    expect(schema).toHaveProperty("type", "object");
    const props = schema["properties"] as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["invoiceNumber", "totals", "vatBreakdown", "lineItems", "seller"]),
    );
  });

  it("supports a sanitizer hook for picky decoding backends", () => {
    const schema = toVlmJsonSchema({
      sanitize: (s) => {
        const clone = JSON.parse(JSON.stringify(s)) as typeof s;
        delete clone["$schema"];
        return clone;
      },
    });
    expect(schema["$schema"]).toBeUndefined();
  });
});
