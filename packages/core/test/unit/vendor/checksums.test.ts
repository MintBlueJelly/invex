import { describe, expect, it } from "vitest";
import {
  isPlausibleSteuernummer,
  isValidIban,
  isValidUstIdNr,
  vendorNameHash,
} from "../../../src/index";

describe("USt-IdNr checksum (ISO 7064 MOD 11,10)", () => {
  it("accepts known-valid numbers", () => {
    expect(isValidUstIdNr("DE136695976")).toBe(true); // canonical spec example
    expect(isValidUstIdNr("DE811907980")).toBe(true); // real issued number
    expect(isValidUstIdNr("de 811907980")).toBe(true); // normalization
  });
  it("rejects transposition/typo errors and junk", () => {
    expect(isValidUstIdNr("DE136695977")).toBe(false);
    expect(isValidUstIdNr("DE811907981")).toBe(false);
    expect(isValidUstIdNr("DE81190798")).toBe(false); // 8 digits
    expect(isValidUstIdNr("ATU12345675")).toBe(false); // not German
  });
});

describe("IBAN mod-97", () => {
  it("accepts valid IBANs (also space-grouped)", () => {
    expect(isValidIban("DE02120300000000202051")).toBe(true);
    expect(isValidIban("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(isValidIban("GB82WEST12345698765432")).toBe(true);
  });
  it("rejects single-digit corruption", () => {
    expect(isValidIban("DE03120300000000202051")).toBe(false);
    expect(isValidIban("DE89370400440532013001")).toBe(false);
  });
});

describe("Steuernummer plausibility", () => {
  it("accepts common formats", () => {
    expect(isPlausibleSteuernummer("143/815/08155")).toBe(true);
    expect(isPlausibleSteuernummer("2893081508152")).toBe(true);
  });
  it("rejects junk", () => {
    expect(isPlausibleSteuernummer("12-345")).toBe(false);
    expect(isPlausibleSteuernummer("DE123456789")).toBe(false);
  });
});

describe("vendor name hash", () => {
  it("is stable across legal-form and punctuation noise", () => {
    const a = vendorNameHash("ACME Bürotechnik GmbH", "80331");
    const b = vendorNameHash("acme bürotechnik gmbh & co. kg", "80331");
    expect(a).toBe(b);
  });
  it("differs across postal codes (name collisions stay local)", () => {
    expect(vendorNameHash("ACME GmbH", "80331")).not.toBe(vendorNameHash("ACME GmbH", "10115"));
  });
});
