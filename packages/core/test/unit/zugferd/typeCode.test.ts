import { describe, expect, it } from "vitest";
import { ciiTypeCodeFor, documentTypeFromCiiTypeCode } from "../../../src/zugferd/typeCode";
import { DOCUMENT_TYPES } from "../../../src/schema/documentType";

describe("documentTypeFromCiiTypeCode — UNTDID 1001 (BT-3)", () => {
  it.each([
    ["380", "invoice"],
    ["384", "invoice"],
    ["386", "invoice"],
    ["389", "invoice"],
    ["381", "creditNote"],
    ["261", "creditNote"],
    ["231", "orderConfirmation"],
    ["270", "deliveryNote"],
    ["310", "quote"],
  ])("maps %s to %s", (code, expected) => {
    expect(documentTypeFromCiiTypeCode(code)).toBe(expected);
  });

  it("tolerates surrounding whitespace", () => {
    expect(documentTypeFromCiiTypeCode(" 381 ")).toBe("creditNote");
  });

  // Path A has no heading to fall back on, and BT-3 validation is an explicit
  // MVP scope cut (briefing §2/§9) — so an unmapped code must not fail the
  // document, it must land on the dominant real case.
  it("falls back to invoice for an absent code", () => {
    expect(documentTypeFromCiiTypeCode(null)).toBe("invoice");
  });

  it("falls back to invoice for an unrecognised code rather than throwing", () => {
    expect(documentTypeFromCiiTypeCode("999")).toBe("invoice");
    expect(documentTypeFromCiiTypeCode("")).toBe("invoice");
  });

  // The distinction that motivated reading BT-3 at all: before this, a 381
  // credit note parsed as an ordinary invoice and, if its arithmetic closed,
  // committed as one.
  it("separates a credit note from an invoice", () => {
    expect(documentTypeFromCiiTypeCode("381")).not.toBe(documentTypeFromCiiTypeCode("380"));
  });
});

describe("ciiTypeCodeFor", () => {
  it("emits a code for every document class", () => {
    for (const t of DOCUMENT_TYPES) expect(ciiTypeCodeFor(t)).toMatch(/^\d{3}$/);
  });

  it("round-trips every class through the mapping", () => {
    for (const t of DOCUMENT_TYPES) {
      expect(documentTypeFromCiiTypeCode(ciiTypeCodeFor(t)), t).toBe(t);
    }
  });

  it("emits the commercial-invoice code for an invoice", () => {
    expect(ciiTypeCodeFor("invoice")).toBe("380");
    expect(ciiTypeCodeFor("creditNote")).toBe("381");
  });
});
