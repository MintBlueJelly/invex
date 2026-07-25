import { describe, expect, it } from "vitest";
import { vlmResultJsonSchema, zVlmResult } from "../../../src/schema/vlm";
import { toVlmJsonSchema } from "../../../src/schema/jsonSchema";
import { zCanonicalInvoice } from "../../../src/schema/invoice";
import { zMarkdownExport } from "../../../src/schema/markdown";
import { knownBug } from "../../../../../test-utils/knownBug";

const validInvoice = {
  schemaVersion: 1,
  invoiceNumber: "R-1",
  issueDate: "2026-06-15",
  dueDate: null,
  currency: "EUR",
  locale: "de-DE",
  seller: { name: "ACME GmbH", ustIdNr: null, steuernummer: null, ibans: [], address: null },
  buyer: null,
  totals: { net: "100.00", tax: "19.00", gross: "119.00" },
  vatBreakdown: [{ rate: 19, net: "100.00", tax: "19.00" }],
  lineItems: [
    { position: 1, description: "Widget", quantity: "1", unit: "Stk", unitPrice: "100.00", taxRate: 19, lineTotal: "100.00" },
  ],
  paymentTerms: null,
};

describe("zVlmResult — the single VLM response contract (briefing §6)", () => {
  it("accepts a well-formed invoice payload", () => {
    const parsed = zVlmResult.safeParse({ isInvoice: true, invoice: validInvoice, markdown: null });
    expect(parsed.success).toBe(true);
  });

  it("accepts a non-invoice payload carrying only markdown", () => {
    const parsed = zVlmResult.safeParse({ isInvoice: false, invoice: null, markdown: "# some doc" });
    expect(parsed.success).toBe(true);
  });

  it("rejects a payload missing isInvoice", () => {
    const parsed = zVlmResult.safeParse({ invoice: null, markdown: "x" });
    expect(parsed.success).toBe(false);
  });

  // The stage handler (vlmEscalate.ts) throws a hard error for this exact shape
  // ("classified as invoice but returned no invoice payload") — but that's an
  // application-level check, not a schema one. The schema itself has no
  // refinement tying isInvoice to invoice, so this combination parses cleanly.
  it("schema-level: isInvoice true + invoice null is NOT rejected by zVlmResult itself", () => {
    const parsed = zVlmResult.safeParse({ isInvoice: true, invoice: null, markdown: null });
    expect(parsed.success).toBe(true);
  });
});

describe("vlmResultJsonSchema — what the VLM actually receives (packages/server vlmEscalate.ts)", () => {
  it("emits a top-level object schema declaring isInvoice/invoice/markdown", () => {
    const schema = vlmResultJsonSchema();
    expect(schema).toMatchObject({ type: "object" });
    expect(Object.keys(schema["properties"] as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["isInvoice", "invoice", "markdown"]),
    );
  });

  it("declares the invoice properties (invoiceNumber, totals, vatBreakdown, lineItems, seller) nested under invoice", () => {
    const schema = vlmResultJsonSchema();
    const invoiceSchema = (schema["properties"] as Record<string, { anyOf?: Array<Record<string, unknown>> }>)[
      "invoice"
    ];
    // invoice is `.nullable()`, which zod emits as anyOf[object, null] rather than a bare object.
    const objectBranch = invoiceSchema?.anyOf?.find((b) => b["type"] === "object");
    expect(objectBranch).toBeDefined();
    expect(Object.keys(objectBranch!["properties"] as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["invoiceNumber", "totals", "vatBreakdown", "lineItems", "seller"]),
    );
  });

  it("carries the money/date pattern constraints all the way into the nested invoice properties", () => {
    // This is the concrete guarantee briefing §6 leans on: schema-guided decoding
    // only constrains the model if these patterns are still present at the leaf,
    // not lost behind indirection. Verified by direct inspection (tsx) before
    // writing this assertion: no $ref/$defs anywhere in the emitted schema —
    // every occurrence of zMoney/zIsoDate is inlined at each use site.
    const schema = vlmResultJsonSchema();
    const json = JSON.stringify(schema);
    expect(json).not.toContain('"$ref"');
    expect(json).toContain("\\\\d{4}-\\\\d{2}-\\\\d{2}$"); // zIsoDate
    expect(json).toContain("\\\\d{1,12}(\\\\.\\\\d{1,2})?$"); // zMoney
  });

  it("supports the sanitize callback (no production caller passes one today, but the hook works)", () => {
    // vlmEscalate.ts calls vlmResultJsonSchema() with zero arguments — this
    // exercises the parameter that exists for picky decoding backends but has
    // no current consumer, so a regression here wouldn't be caught elsewhere.
    const schema = vlmResultJsonSchema((s) => {
      const clone = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
      delete clone["$schema"];
      return clone;
    });
    expect(schema["$schema"]).toBeUndefined();
  });
});

describe("toVlmJsonSchema vs vlmResultJsonSchema — compatibility", () => {
  it("toVlmJsonSchema (tested, no production consumer) matches the invoice shape nested inside vlmResultJsonSchema (untested, the actual consumer)", () => {
    const standalone = toVlmJsonSchema();
    const nested = vlmResultJsonSchema();
    const invoiceBranch = (nested["properties"] as Record<string, { anyOf: Array<Record<string, unknown>> }>)[
      "invoice"
    ]!.anyOf.find((b) => b["type"] === "object")!;
    // Both are derived from zCanonicalInvoice, so their required/property sets
    // must line up even though nothing in the codebase asserts this today.
    expect(Object.keys(standalone["properties"] as Record<string, unknown>).sort()).toEqual(
      Object.keys(invoiceBranch["properties"] as Record<string, unknown>).sort(),
    );
    expect(standalone["required"]).toEqual(invoiceBranch["required"]);
  });
});

describe("jsonSchema.ts — toVlmJsonSchema()", () => {
  it("derives an object schema with additionalProperties: false", () => {
    const schema = toVlmJsonSchema();
    expect(schema["type"]).toBe("object");
    expect(schema["additionalProperties"]).toBe(false);
  });

  it("supports its own sanitize option independently", () => {
    const schema = toVlmJsonSchema({ sanitize: (s) => ({ ...s, injected: true }) });
    expect(schema["injected"]).toBe(true);
  });
});

describe("markdown.ts — zMarkdownExport", () => {
  it("accepts a well-formed markdown export", () => {
    const parsed = zMarkdownExport.safeParse({
      documentId: "123e4567-e89b-12d3-a456-426614174000",
      classification: "non_invoice",
      source: "docling",
      markdown: "# hi",
      pageCount: 1,
      classifierScore: 0.2,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid classification enum value", () => {
    const parsed = zMarkdownExport.safeParse({
      documentId: "123e4567-e89b-12d3-a456-426614174000",
      classification: "bogus",
      source: "docling",
      markdown: "# hi",
      pageCount: 1,
      classifierScore: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a negative pageCount", () => {
    const parsed = zMarkdownExport.safeParse({
      documentId: "123e4567-e89b-12d3-a456-426614174000",
      classification: "non_invoice",
      source: "docling",
      markdown: "# hi",
      pageCount: -1,
      classifierScore: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("exists as an exported schema with no production importer today", () => {
    // grep across packages/{core,server}/src turns up zero imports of
    // zMarkdownExport/MarkdownExport outside this schema file's own definition
    // and its index.ts re-export — vlmEscalate.ts builds the markdown-export
    // update inline instead of constructing/validating a MarkdownExport. Recorded
    // here so the gap is visible rather than silently assumed.
    expect(zMarkdownExport).toBeDefined();
  });
});

describe("invoice.ts sub-schemas — negative cases (complementing invoice.test.ts)", () => {
  it("rejects money with 3+ decimal places", () => {
    expect(zCanonicalInvoice.shape.totals.shape.net.safeParse("100.123").success).toBe(false);
  });

  it("allows negative money (credit notes / corrections are in-band, not rejected)", () => {
    expect(zCanonicalInvoice.shape.totals.shape.net.safeParse("-100.00").success).toBe(true);
  });

  it("rejects a currency code that isn't exactly 3 characters", () => {
    expect(zCanonicalInvoice.shape.currency.safeParse("EU").success).toBe(false);
    expect(zCanonicalInvoice.shape.currency.safeParse("EURO").success).toBe(false);
  });

  it("rejects a countryCode that isn't exactly 2 characters", () => {
    const zCountryCode = zCanonicalInvoice.shape.seller.shape.address.unwrap().shape.countryCode;
    expect(zCountryCode.safeParse("DEU").success).toBe(false);
    expect(zCountryCode.safeParse("D").success).toBe(false);
  });

  it("rejects an empty vatBreakdown array", () => {
    expect(zCanonicalInvoice.shape.vatBreakdown.safeParse([]).success).toBe(false);
  });

  it("rejects an empty lineItems array", () => {
    expect(zCanonicalInvoice.shape.lineItems.safeParse([]).success).toBe(false);
  });

  it("accepts quantity/unitPrice at 4 decimal places, rejects 5", () => {
    const zQuantity = zCanonicalInvoice.shape.lineItems.element.shape.quantity.unwrap();
    const zUnitPrice = zCanonicalInvoice.shape.lineItems.element.shape.unitPrice.unwrap();
    expect(zQuantity.safeParse("1.2345").success).toBe(true);
    expect(zQuantity.safeParse("1.23456").success).toBe(false);
    expect(zUnitPrice.safeParse("1.2345").success).toBe(true);
    expect(zUnitPrice.safeParse("1.23456").success).toBe(false);
  });

  it("rejects a rate above 100", () => {
    expect(zCanonicalInvoice.shape.vatBreakdown.element.shape.rate.safeParse(101).success).toBe(false);
  });

  it("rejects an empty line-item description", () => {
    expect(zCanonicalInvoice.shape.lineItems.element.shape.description.safeParse("").success).toBe(false);
  });

  it("distinguishes a MISSING optional key from an explicit null (nullable is not the same as optional)", () => {
    // docs/api.md is explicit that these differ. zPostalAddress/zSeller etc. use
    // `.nullable()` everywhere, not `.optional()`, so a key must always be
    // present — VLM output that OMITS a nullable field is a schema violation,
    // not a benign gap.
    const { paymentTerms: _drop, ...withoutPaymentTerms } = validInvoice;
    expect(zCanonicalInvoice.safeParse(withoutPaymentTerms).success).toBe(false);
    expect(zCanonicalInvoice.safeParse({ ...validInvoice, paymentTerms: null }).success).toBe(true);
  });
});

describe("INVEX-040 — zIsoDate has no calendar validation", () => {
  it("[current] accepts calendar-impossible dates as valid ISO dates", () => {
    expect(zCanonicalInvoice.shape.issueDate.safeParse("2026-13-45").success).toBe(true);
    expect(zCanonicalInvoice.shape.issueDate.safeParse("2026-02-30").success).toBe(true);
  });

  knownBug("INVEX-040", "zIsoDate accepts calendar-impossible dates").it(
    "rejects a hallucinated impossible issueDate before it reaches CanonicalInvoice",
    () => {
      expect(zCanonicalInvoice.shape.issueDate.safeParse("2026-13-45").success).toBe(false);
      expect(zCanonicalInvoice.shape.issueDate.safeParse("2026-02-30").success).toBe(false);
    },
  );
});
