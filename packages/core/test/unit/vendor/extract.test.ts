import { describe, expect, it } from "vitest";
import { extractVendorIds, vendorNameHash } from "../../../src/index";
import { knownBug } from "../../../../../test-utils/knownBug";
import { doc, line } from "../../utils/positionedBuilders";

/**
 * extractVendorIds scans a positioned document for the vendor-key chain
 * (briefing §3): USt-IdNr → Steuernummer → IBAN → name+postcode hash, in that
 * priority order. Checksum algorithms themselves are covered by
 * checksums.test.ts — this file is about locating the right substrings on a
 * realistic (or adversarial) page.
 */

describe("full German letterhead", () => {
  it("extracts all four identifier kinds from a clean invoice header", () => {
    const ids = extractVendorIds(
      doc([
        "ACME Bürotechnik GmbH",
        "Industriestraße 12",
        "80331 München",
        "USt-IdNr.: DE811907980",
        "Bankverbindung: IBAN DE02120300000000202051",
      ]),
    );
    expect(ids.ustIdNr).toBe("DE811907980");
    expect(ids.ibans).toEqual(["DE02120300000000202051"]);
    expect(ids.nameGuess).toBe("ACME Bürotechnik GmbH");
    expect(ids.postalCodeGuess).toBe("80331");
    // nameHash is derived, not independently guessed — pin it to the exact value.
    expect(ids.nameHash).toBe(vendorNameHash("ACME Bürotechnik GmbH", "80331"));
  });
});

describe("USt-IdNr scanning", () => {
  it("matches DE immediately followed by digits, no space", () => {
    const ids = extractVendorIds(doc(["USt-IdNr.:DE811907980"]));
    expect(ids.ustIdNr).toBe("DE811907980");
  });

  it("matches DE with a single separating space", () => {
    const ids = extractVendorIds(doc(["USt-IdNr.: DE 811907980"]));
    expect(ids.ustIdNr).toBe("DE811907980");
  });

  it("matches through surrounding punctuation", () => {
    const ids = extractVendorIds(doc(["(USt-IdNr. DE811907980)"]));
    expect(ids.ustIdNr).toBe("DE811907980");
  });

  it("rejects a candidate whose checksum fails, leaving ustIdNr null", () => {
    // DE811907981 is the same real number with the last digit bumped — invalid per checksums.test.ts.
    const ids = extractVendorIds(doc(["USt-IdNr.: DE811907981"]));
    expect(ids.ustIdNr).toBeNull();
  });

  it("does not find a non-German VAT id — the scan is DE-only", () => {
    // A real, validly-formed Austrian USt-IdNr; extractVendorIds has no ATU pattern at all.
    const ids = extractVendorIds(doc(["UID: ATU13585627"]));
    expect(ids.ustIdNr).toBeNull();
  });
});

describe("Steuernummer scanning (label-anchored only)", () => {
  it("finds the slash-grouped format next to a 'Steuernummer' label", () => {
    const ids = extractVendorIds(doc(["Steuernummer: 143/815/08155"]));
    expect(ids.steuernummer).toBe("143/815/08155");
  });

  it("finds the 13-digit unified format next to a 'Steuer-Nr' label", () => {
    const ids = extractVendorIds(doc(["Steuer-Nr. 2893081508152"]));
    expect(ids.steuernummer).toBe("2893081508152");
  });

  it("does NOT treat an unlabeled 10-digit run as a Steuernummer", () => {
    // Same shape a Steuernummer can take (bare 10-13 digits), but it's a customer
    // number / phone number with no "steuernummer|steuer-?nr" label anywhere on the page.
    const ids = extractVendorIds(
      doc(["Kundennummer: 4815162342", "Telefon: 089 1234567"]),
    );
    expect(ids.steuernummer).toBeNull();
  });
});

describe("IBAN scanning", () => {
  it("matches a space-grouped IBAN", () => {
    const ids = extractVendorIds(doc(["Konto: IBAN DE89 3704 0044 0532 0130 00"]));
    expect(ids.ibans).toEqual(["DE89370400440532013000"]);
  });

  it("collects several distinct IBANs from the same page, including a non-DE one", () => {
    const ids = extractVendorIds(
      doc([
        "Bankverbindung 1: IBAN DE02120300000000202051",
        "Bankverbindung 2 (UK): IBAN GB82WEST12345698765432",
      ]),
    );
    expect(ids.ibans).toEqual(["DE02120300000000202051", "GB82WEST12345698765432"]);
  });

  it("drops an IBAN whose mod-97 checksum fails but keeps a valid one alongside it", () => {
    const ids = extractVendorIds(
      doc(["IBAN: DE03120300000000202051", "IBAN: DE02120300000000202051"]),
    );
    expect(ids.ibans).toEqual(["DE02120300000000202051"]);
  });
});

describe("letterhead name/postcode heuristics", () => {
  it("ignores lines on page 2 — only page 1 feeds nameGuess/postalCodeGuess", () => {
    const ids = extractVendorIds(
      doc([
        line("Page 2 continuation, ignore me 99999", { page: 2, y: 0.05 }),
        line("ACME Bürotechnik GmbH", { page: 1, y: 0.05 }),
        line("80331 München", { page: 1, y: 0.09 }),
      ]),
    );
    expect(ids.nameGuess).toBe("ACME Bürotechnik GmbH");
    expect(ids.postalCodeGuess).toBe("80331");
  });

  it("finds nothing plausible on a page of short/numeric-only lines", () => {
    const ids = extractVendorIds(doc(["123", "45", "6789012"]));
    expect(ids.nameGuess).toBeNull();
    expect(ids.postalCodeGuess).toBeNull();
    expect(ids.nameHash).toBeNull(); // no name to hash, regardless of postcode
  });
});

describe("degenerate documents", () => {
  it("returns all-null/empty on an empty document", () => {
    const ids = extractVendorIds(doc([]));
    expect(ids.ustIdNr).toBeNull();
    expect(ids.steuernummer).toBeNull();
    expect(ids.ibans).toEqual([]);
    expect(ids.nameGuess).toBeNull();
    expect(ids.postalCodeGuess).toBeNull();
    expect(ids.nameHash).toBeNull();
  });

  it("finds no vendor/tax identifiers on a page of unrelated numbers", () => {
    const ids = extractVendorIds(doc(["123456789", "0123456789012"]));
    expect(ids.ustIdNr).toBeNull();
    expect(ids.steuernummer).toBeNull();
    expect(ids.ibans).toEqual([]);
  });
});

describe("known bugs", () => {
  it("[current] a lowercase/mixed-case OCR'd IBAN line yields no IBANs at all", () => {
    // The match regex requires literal uppercase [A-Z]{2} up front; normalizeIban
    // only uppercases AFTER matching, so lowercase never reaches it.
    const ids = extractVendorIds(doc(["iban de02120300000000202051"]));
    expect(ids.ibans).toEqual([]);
  });
  knownBug("INVEX-036", "IBAN regex is case-sensitive, missing lowercase OCR text").it(
    "finds the IBAN regardless of case",
    () => {
      const ids = extractVendorIds(doc(["iban de02120300000000202051"]));
      expect(ids.ibans).toEqual(["DE02120300000000202051"]);
    },
  );

  it("[current] a page header above the real letterhead is taken as the vendor name, and the recipient's postcode as the vendor's", () => {
    const ids = extractVendorIds(
      doc([
        "Seite 1 von 2", // OCR page-header artefact, not a vendor name
        "Max Mustermann", // recipient block — sits above the sender on a German letter
        "Musterstraße 5",
        "10115 Berlin", // recipient's postcode
        "ACME Bürotechnik GmbH", // actual vendor, further down the page
        "Industriestraße 12",
        "80331 München", // actual vendor postcode
        "USt-IdNr.: DE811907980",
      ]),
    );
    expect(ids.nameGuess).toBe("Seite 1 von 2");
    expect(ids.postalCodeGuess).toBe("10115");
  });
  knownBug("INVEX-037", "letterhead heuristic grabs the page header as vendor name").it(
    "takes the real vendor name, not the page-header artefact",
    () => {
      const ids = extractVendorIds(
        doc([
          "Seite 1 von 2",
          "Max Mustermann",
          "Musterstraße 5",
          "10115 Berlin",
          "ACME Bürotechnik GmbH",
          "Industriestraße 12",
          "80331 München",
          "USt-IdNr.: DE811907980",
        ]),
      );
      expect(ids.nameGuess).toBe("ACME Bürotechnik GmbH");
    },
  );
  knownBug("INVEX-037", "postalCodeGuess grabs the recipient's postcode, not the vendor's").it(
    "takes the vendor's own postcode, not the recipient's",
    () => {
      const ids = extractVendorIds(
        doc([
          "Seite 1 von 2",
          "Max Mustermann",
          "Musterstraße 5",
          "10115 Berlin",
          "ACME Bürotechnik GmbH",
          "Industriestraße 12",
          "80331 München",
          "USt-IdNr.: DE811907980",
        ]),
      );
      expect(ids.postalCodeGuess).toBe("80331");
    },
  );

  it("[current] a trailing 'DE' absorbs digits from the NEXT line into a fabricated, checksum-valid USt-IdNr", () => {
    // "DE1" ends line 1; the joined "\n" plus line 2's leading "36695976" is exactly
    // shaped like a 9-digit VAT id and happens to pass ISO 7064 (DE136695976 is the
    // canonical valid example from checksums.test.ts) — pure coincidence of digits
    // that were never adjacent on the actual page.
    const ids = extractVendorIds(
      doc(["Kundennummer 12345 USt-IdNr. DE1", "36695976 Musterfirma GmbH"]),
    );
    expect(ids.ustIdNr).toBe("DE136695976");
  });
  knownBug("INVEX-038", "DE VAT scan crosses a line break and fabricates a VAT id").it(
    "does not fabricate a USt-IdNr by joining digits across a line break",
    () => {
      const ids = extractVendorIds(
        doc(["Kundennummer 12345 USt-IdNr. DE1", "36695976 Musterfirma GmbH"]),
      );
      expect(ids.ustIdNr).toBeNull();
    },
  );
});
