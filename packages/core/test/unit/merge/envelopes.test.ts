import { describe, expect, it } from "vitest";
import { knownBug } from "../../../../../test-utils/knownBug";
import { mergeEnvelopes } from "../../../src/index";
import type {
  CandidateInvoice,
  ExtractionEnvelope,
  FieldMeta,
  FieldSource,
} from "../../../src/schema/candidate";

/**
 * mergeEnvelopes combines a PRIMARY source (a vendor template, or a VLM
 * re-read) with a SECONDARY fallback (the generic rule engine, or a prior
 * deterministic pass). Precedence must be exact: a lower-confidence secondary
 * must never silently clobber a primary value, and fieldMeta provenance must
 * track whichever value actually made it into the output.
 */

function envelope(
  invoice: CandidateInvoice,
  fieldMeta: Record<string, FieldMeta> = {},
): ExtractionEnvelope {
  return { invoice, fieldMeta };
}

function meta(source: FieldSource, confidence: number): FieldMeta {
  return { source, confidence };
}

describe("mergeEnvelopes — scalar precedence", () => {
  it("primary's value wins when both sources have one (template over rule engine)", () => {
    const primary = envelope({ invoiceNumber: "RE-1" });
    const secondary = envelope({ invoiceNumber: "RE-2" });
    expect(mergeEnvelopes(primary, secondary).invoice.invoiceNumber).toBe("RE-1");
  });

  it("secondary fills in a field the primary never touched", () => {
    const primary = envelope({ invoiceNumber: "RE-1" });
    const secondary = envelope({ currency: "EUR" });
    expect(mergeEnvelopes(primary, secondary).invoice.currency).toBe("EUR");
  });

  it("[current] an explicit null in primary is treated as absent, not as a confident 'no value' — secondary wins", () => {
    // Real shape: a VLM re-read reports dueDate: null ("no due date visible"),
    // while the rule engine (secondary) guessed a date off a payment-terms
    // line. `pick()` has no way to tell "confidently absent" from "never
    // looked", so the lower-confidence guess overwrites the explicit null.
    const primary = envelope({ dueDate: null });
    const secondary = envelope({ dueDate: "2026-08-01" });
    expect(mergeEnvelopes(primary, secondary).invoice.dueDate).toBe("2026-08-01");
  });

  it("[current] primary null with secondary also absent collapses to undefined, not null", () => {
    const primary = envelope({ dueDate: null });
    const secondary = envelope({});
    expect(mergeEnvelopes(primary, secondary).invoice.dueDate).toBeUndefined();
  });
});

describe("mergeEnvelopes — nested objects: seller/totals merge per sub-field, buyer does not", () => {
  it("seller merges sub-fields across sources (primary name + secondary VAT id both survive)", () => {
    const primary = envelope({ seller: { name: "ACME GmbH" } });
    const secondary = envelope({ seller: { ustIdNr: "DE123456789" } });
    const result = mergeEnvelopes(primary, secondary);
    expect(result.invoice.seller).toEqual({
      name: "ACME GmbH",
      ustIdNr: "DE123456789",
      steuernummer: null,
      ibans: [],
      address: null,
    });
  });

  it("totals merges sub-fields across sources the same way (primary net + secondary tax/gross)", () => {
    const primary = envelope({ totals: { net: "100.00" } });
    const secondary = envelope({ totals: { tax: "19.00", gross: "119.00" } });
    const result = mergeEnvelopes(primary, secondary);
    expect(result.invoice.totals).toEqual({ net: "100.00", tax: "19.00", gross: "119.00" });
  });

  it("[current] buyer is picked WHOLESALE, unlike seller/totals — secondary's customerNumber is lost", () => {
    // Template (primary) read the buyer's name off the letterhead but not the
    // customer number; the rule engine (secondary) found the customer number
    // from an "Ihre Kundennummer" line. buyer goes through the generic pick()
    // rather than a per-field merge, so once primary has ANY buyer object the
    // whole secondary buyer object — including the customer number — is dropped.
    const primary = envelope({ buyer: { name: "Kunde KG" } });
    const secondary = envelope({ buyer: { customerNumber: "K-9001" } });
    const result = mergeEnvelopes(primary, secondary);
    expect(result.invoice.buyer).toEqual({ name: "Kunde KG" });
  });
});

describe("mergeEnvelopes — lineItems and vatBreakdown are wholesale, not merged element-wise", () => {
  const item = (description: string) => ({ description });

  it("primary wins wholesale even with far fewer rows than secondary (not a 'longer array wins' rule)", () => {
    const primary = envelope({ lineItems: [item("A")] });
    const secondary = envelope({
      lineItems: [item("B1"), item("B2"), item("B3"), item("B4"), item("B5")],
    });
    const result = mergeEnvelopes(primary, secondary);
    expect(result.invoice.lineItems).toEqual([item("A")]);
  });

  it("secondary's rows are used wholesale when primary found none", () => {
    const primary = envelope({ lineItems: [] });
    const secondary = envelope({ lineItems: [item("B1"), item("B2")] });
    const result = mergeEnvelopes(primary, secondary);
    expect(result.invoice.lineItems).toEqual([item("B1"), item("B2")]);
  });

  it("tie: both empty arrays resolves to the secondary's own (empty) array", () => {
    const primary = envelope({ lineItems: [] });
    const secondary = envelope({ lineItems: [] });
    const result = mergeEnvelopes(primary, secondary);
    expect(result.invoice.lineItems).toEqual([]);
    expect(result.invoice.lineItems).toBe(secondary.invoice.lineItems);
  });

  it("vatBreakdown follows the identical wholesale rule", () => {
    const primary = envelope({ vatBreakdown: [] });
    const secondary = envelope({ vatBreakdown: [{ rate: 19, net: "100.00", tax: "19.00" }] });
    const result = mergeEnvelopes(primary, secondary);
    expect(result.invoice.vatBreakdown).toEqual([{ rate: 19, net: "100.00", tax: "19.00" }]);
  });
});

describe("mergeEnvelopes — fieldMeta provenance", () => {
  it("primary's provenance wins key-wise, secondary's fills keys primary never set", () => {
    const primary = envelope(
      { invoiceNumber: "RE-1" },
      { invoiceNumber: meta("template", 0.95) },
    );
    const secondary = envelope(
      { invoiceNumber: "RE-2", currency: "EUR" },
      { invoiceNumber: meta("rules", 0.4), currency: meta("rules", 0.6) },
    );
    const result = mergeEnvelopes(primary, secondary);
    expect(result.fieldMeta.invoiceNumber).toEqual(meta("template", 0.95));
    expect(result.fieldMeta.currency).toEqual(meta("rules", 0.6));
  });

  it("[current] stale primary fieldMeta for lineItems.0 survives even though the merged array actually came from secondary", () => {
    // Reproduces a real pipeline shape: an earlier template run once found a
    // line item at index 0 and recorded fieldMeta for it, then a corrected
    // re-run zeroed out primary.lineItems without clearing that stale
    // "lineItems.0.*" entry. The lineItems ARRAY is taken wholesale from
    // secondary (primary is empty, see above), but the fieldMeta merge is a
    // wholly separate, key-wise operation — so primary's stale entry still
    // wins and now describes a row it never produced.
    const primary = envelope(
      { lineItems: [] },
      { "lineItems.0.description": meta("template", 0.9) },
    );
    const secondary = envelope(
      { lineItems: [{ description: "Aktenvernichter" }] },
      { "lineItems.0.description": meta("rules", 0.5) },
    );
    const result = mergeEnvelopes(primary, secondary);
    expect(result.invoice.lineItems).toEqual([{ description: "Aktenvernichter" }]);
    expect(result.fieldMeta["lineItems.0.description"]).toEqual(meta("template", 0.9));
  });
});

describe("mergeEnvelopes — key presence on the result object", () => {
  it("[current] plain scalar/array keys are always present (possibly undefined); totals/seller are omitted entirely when neither source has them", () => {
    const primary = envelope({});
    const secondary = envelope({});
    const result = mergeEnvelopes(primary, secondary).invoice;
    // pick()-based fields: key is always assigned, JSON.stringify would drop
    // the value but the key exists on the object either way.
    expect("invoiceNumber" in result).toBe(true);
    expect(result.invoiceNumber).toBeUndefined();
    expect("lineItems" in result).toBe(true);
    expect(result.lineItems).toBeUndefined();
    // totals/seller are built via a conditional spread — absent from both
    // sources means the key itself is missing, not merely undefined-valued.
    expect("totals" in result).toBe(false);
    expect("seller" in result).toBe(false);
  });
});

describe("mergeEnvelopes — empty envelope combined with a full one, and self-merge", () => {
  // Seller/totals are always rebuilt by the merge with explicit `null` for
  // any sub-field neither source set, so the fixture spells those out too —
  // otherwise toEqual would see a real key/`null` on one side and a missing
  // key/`undefined` on the other and (correctly) call that a mismatch.
  const full: ExtractionEnvelope = envelope(
    {
      invoiceNumber: "RE-42",
      issueDate: "2026-07-01",
      dueDate: "2026-07-31",
      currency: "EUR",
      locale: "de-DE",
      seller: {
        name: "ACME GmbH",
        ustIdNr: "DE123456789",
        steuernummer: null,
        ibans: ["DE00123456780000000000"],
        address: null,
      },
      buyer: { name: "Kunde KG", customerNumber: "K-1" },
      totals: { net: "100.00", tax: "19.00", gross: "119.00" },
      vatBreakdown: [{ rate: 19, net: "100.00", tax: "19.00" }],
      lineItems: [{ description: "Aktenvernichter", quantity: "1" }],
      paymentTerms: "30 Tage netto",
    },
    { invoiceNumber: meta("template", 0.95) },
  );
  const empty: ExtractionEnvelope = envelope({});

  it("full as primary, empty as secondary reproduces the full invoice untouched", () => {
    const result = mergeEnvelopes(full, empty);
    expect(result.invoice).toEqual(full.invoice);
    expect(result.fieldMeta).toEqual(full.fieldMeta);
  });

  it("empty as primary, full as secondary also reproduces the full invoice", () => {
    const result = mergeEnvelopes(empty, full);
    expect(result.invoice).toEqual(full.invoice);
    expect(result.fieldMeta).toEqual(full.fieldMeta);
  });

  it("merging the full envelope with itself is idempotent", () => {
    const result = mergeEnvelopes(full, full);
    expect(result.invoice).toEqual(full.invoice);
    expect(result.fieldMeta).toEqual(full.fieldMeta);
  });
});

describe("mergeEnvelopes — known defects", () => {
  knownBug("INVEX-044", "buyer is merged wholesale while seller and totals merge per-field")
    .it("merges buyer sub-fields the way it merges seller sub-fields", () => {
      // Three structurally identical nested objects, two different rules: seller
      // and totals combine per sub-field, buyer goes through the generic pick()
      // and is taken whole. A template that found only the buyer's name
      // therefore discards a customer number the rule engine did find.
      const merged = mergeEnvelopes(
        { invoice: { buyer: { name: "Beispiel AG" } }, fieldMeta: {} },
        { invoice: { buyer: { customerNumber: "K-4711" } }, fieldMeta: {} },
      );
      expect(merged.invoice.buyer).toMatchObject({ name: "Beispiel AG", customerNumber: "K-4711" });
    });

  knownBug("INVEX-045", "fieldMeta merges key-wise regardless of which source won the array")
    .it("does not attribute provenance to a source whose rows were discarded", () => {
      // Arrays are taken wholesale (primary if non-empty, else secondary) but
      // fieldMeta is merged key-wise with primary winning, independently. A
      // primary holding an empty lineItems array plus stale per-row metadata
      // therefore stamps its provenance onto rows that came from secondary —
      // so audit tooling credits the wrong extractor for data it never saw.
      const merged = mergeEnvelopes(
        { invoice: { lineItems: [] }, fieldMeta: { "lineItems.0": { source: "template", confidence: 0.95 } } },
        {
          invoice: { lineItems: [{ description: "Aktenvernichter" }] },
          fieldMeta: { "lineItems.0": { source: "rules", confidence: 0.6 } },
        },
      );
      expect(merged.invoice.lineItems).toHaveLength(1);
      expect(merged.fieldMeta["lineItems.0"]?.source).toBe("rules");
    });
});
