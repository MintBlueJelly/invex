import { describe, expect, it } from "vitest";
import { parseCiiToEnvelope, reconcile } from "@invex/core";
import { computeInvoice, sampleSpec, serializeCii } from "../../src/index";

describe("CII round-trip (fixtures serializer ↔ core parser)", () => {
  it("serialize → parse → reconcile yields the spec's arithmetic truth", () => {
    const spec = sampleSpec();
    const expected = computeInvoice(spec);

    const envelope = parseCiiToEnvelope(serializeCii(spec));
    expect(envelope.invoice.invoiceNumber).toBe(spec.invoiceNumber);
    expect(envelope.invoice.issueDate).toBe(spec.issueDate);
    expect(envelope.invoice.seller?.ustIdNr).toBe(spec.seller.ustIdNr);
    expect(envelope.invoice.seller?.ibans).toEqual([spec.seller.iban]);
    expect(envelope.invoice.lineItems).toHaveLength(spec.lines.length);
    expect(envelope.fieldMeta["invoiceNumber"]?.source).toBe("zugferd");

    const result = reconcile(envelope);
    expect(result.violations).toEqual([]);
    expect(result.status).toBe("reconciled");
    expect(result.invoice?.totals).toEqual(expected.totals);
    expect(result.invoice?.vatBreakdown).toEqual(expected.vat);
  });

  it("multi-rate specs round-trip with a per-rate breakdown", () => {
    const spec = sampleSpec({
      lines: [
        { description: "Hardware", quantity: "1", unitPrice: "100.00", taxRate: 19 },
        { description: "Fachbuch", quantity: "2", unitPrice: "25.00", taxRate: 7 },
      ],
    });
    const envelope = parseCiiToEnvelope(serializeCii(spec));
    const result = reconcile(envelope);
    expect(result.status).toBe("reconciled");
    expect(result.invoice?.vatBreakdown).toEqual([
      { rate: 19, net: "100.00", tax: "19.00" },
      { rate: 7, net: "50.00", tax: "3.50" },
    ]);
  });

  it("throws on truncated XML (the graceful-fallthrough trigger)", () => {
    const xml = serializeCii(sampleSpec());
    expect(() => parseCiiToEnvelope(xml.slice(0, 500))).toThrow();
    expect(() => parseCiiToEnvelope("<foo>not cii</foo>")).toThrow(/CrossIndustryInvoice/);
  });
});
