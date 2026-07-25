import { parseCiiToEnvelope, reconcile } from "@invex/core";
import { describe, expect, it } from "vitest";
import { serializeCiiFromCanonical } from "../../src/ciiFromCanonical";
import { loadGolden, loadGoldens } from "../../src/goldens";

/**
 * Path A round-trip: hand-authored canonical → CII XML → parser → solver.
 *
 * The version this replaces serialized from `computeInvoice(spec)` and then
 * asserted the parsed result matched `computeInvoice(spec)` — the same function
 * on both sides of the round trip, so it could only ever prove the arithmetic
 * agreed with itself. Serializing a golden's INDEPENDENTLY authored canonical
 * makes the assertion about `parseCiiToEnvelope` instead.
 */

const invoiceGoldens = loadGoldens().filter((g) => g.expected.canonical !== null);

describe("CII round-trip over the golden corpus", () => {
  it.each(invoiceGoldens.map((g) => [g.id, g] as const))(
    "%s: parses back to the hand-authored canonical",
    (_id, g) => {
      const inv = g.expected.canonical!;
      const result = reconcile(parseCiiToEnvelope(serializeCiiFromCanonical(inv)));

      expect(result.status, JSON.stringify(result.violations)).toBe("reconciled");
      expect(result.invoice?.invoiceNumber).toBe(inv.invoiceNumber);
      expect(result.invoice?.issueDate).toBe(inv.issueDate);
      expect(result.invoice?.totals).toEqual(inv.totals);
      expect(result.invoice?.vatBreakdown).toEqual(inv.vatBreakdown);
      expect(result.invoice?.lineItems.map((l) => l.description)).toEqual(
        inv.lineItems.map((l) => l.description),
      );
      expect(result.invoice?.lineItems.map((l) => l.lineTotal)).toEqual(
        inv.lineItems.map((l) => l.lineTotal),
      );
    },
  );

  it("records zugferd provenance for the fields it read", () => {
    const envelope = parseCiiToEnvelope(
      serializeCiiFromCanonical(loadGolden("de-standard-19").expected.canonical!),
    );
    expect(envelope.fieldMeta["invoiceNumber"]?.source).toBe("zugferd");
    expect(envelope.fieldMeta["totals.gross"]?.source).toBe("zugferd");
  });

  it("carries both rates through a multi-rate document", () => {
    const inv = loadGolden("de-multi-rate-19-7").expected.canonical!;
    const result = reconcile(parseCiiToEnvelope(serializeCiiFromCanonical(inv)));
    expect(result.invoice?.vatBreakdown).toHaveLength(2);
    expect(result.invoice?.vatBreakdown.map((v) => v.rate)).toEqual([19, 7]);
  });

  it("carries a 0 % rate through, so a §19 invoice is not silently dropped", () => {
    const inv = loadGolden("de-kleinunternehmer-19ustg").expected.canonical!;
    const result = reconcile(parseCiiToEnvelope(serializeCiiFromCanonical(inv)));
    expect(result.status).toBe("reconciled");
    expect(result.invoice?.vatBreakdown).toEqual([{ rate: 0, net: "1000.00", tax: "0.00" }]);
  });

  it("extracts the seller's tax identifiers by scheme", () => {
    const ust = loadGolden("de-standard-19").expected.canonical!;
    const steuer = loadGolden("de-kleinunternehmer-19ustg").expected.canonical!;
    expect(parseCiiToEnvelope(serializeCiiFromCanonical(ust)).invoice.seller?.ustIdNr).toBe(
      ust.seller.ustIdNr,
    );
    expect(parseCiiToEnvelope(serializeCiiFromCanonical(steuer)).invoice.seller?.steuernummer).toBe(
      steuer.seller.steuernummer,
    );
    expect(parseCiiToEnvelope(serializeCiiFromCanonical(ust)).invoice.seller?.ibans).toEqual(
      ust.seller.ibans,
    );
  });
});

describe("malformed CII throws, so Path A falls through to Path B", () => {
  const inv = loadGolden("de-standard-19").expected.canonical!;

  it("throws on truncated XML", () => {
    expect(() => parseCiiToEnvelope(serializeCiiFromCanonical(inv, { truncateAt: 500 }))).toThrow();
  });

  it("throws on a non-CII root element", () => {
    expect(() => parseCiiToEnvelope("<foo>not cii</foo>")).toThrow(/CrossIndustryInvoice/);
  });

  it("throws on an empty document", () => {
    expect(() => parseCiiToEnvelope("")).toThrow();
  });
});
