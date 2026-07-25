import { describe, expect, it } from "vitest";
import { parseCiiToEnvelope } from "../../../src/index";
import { knownBug } from "../../../../../test-utils/knownBug";

/**
 * Hand-authored CII (ZUGfERD/Factur-X/XRechnung) fixtures. Deliberately NOT
 * routed through the fixtures package's serializer — the point is to exercise
 * the parser against XML shaped the way real invoicing software emits it
 * (repeated elements, scheme-less tax IDs, fallback description sources),
 * independent of what our own generator happens to produce.
 */

interface LineOpts {
  lineId?: string;
  /** Inner XML of SpecifiedTradeProduct; "" omits the element entirely. */
  productXml?: string;
  /** Inner XML of AssociatedDocumentLineDocument/IncludedNote; "" omits it. */
  noteXml?: string;
  quantity?: string;
  unitCode?: string;
  unitPrice?: string;
  taxXml?: string;
  lineTotal?: string;
}

function lineItem(opts: LineOpts = {}): string {
  const {
    lineId = "1",
    productXml = "<ram:Name>Bueromaterial</ram:Name>",
    noteXml = "",
    quantity = "2",
    unitCode = "C62",
    unitPrice = "100.00",
    taxXml = "<ram:ApplicableTradeTax><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>",
    lineTotal = "200.00",
  } = opts;
  const note = noteXml ? `<ram:IncludedNote>${noteXml}</ram:IncludedNote>` : "";
  const product = productXml ? `<ram:SpecifiedTradeProduct>${productXml}</ram:SpecifiedTradeProduct>` : "";
  return `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${lineId}</ram:LineID>${note}</ram:AssociatedDocumentLineDocument>
      ${product}
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>${unitPrice}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${unitCode}">${quantity}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        ${taxXml}
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${lineTotal}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
}

function taxReg(schemeID: string | null, id: string): string {
  const attr = schemeID ? ` schemeID="${schemeID}"` : "";
  return `<ram:SpecifiedTaxRegistration><ram:ID${attr}>${id}</ram:ID></ram:SpecifiedTaxRegistration>`;
}

interface DocOpts {
  invoiceNumber?: string;
  issueDate?: string;
  currency?: string;
  sellerName?: string;
  sellerAddressXml?: string;
  sellerTaxRegXml?: string;
  /** null omits BuyerTradeParty entirely (untypical but legal for some minimal profiles). */
  buyerXml?: string | null;
  paymentMeansXml?: string;
  vatXml?: string;
  termsXml?: string;
  totalsXml?: string;
  linesXml?: string;
}

/** A minimal but complete single-rate CII document; override only what a test varies. */
function buildCii(opts: DocOpts = {}): string {
  const {
    invoiceNumber = "RE-2026-001",
    issueDate = "20260115",
    currency = "EUR",
    sellerName = "ACME Buerobedarf GmbH",
    sellerAddressXml = `<ram:PostalTradeAddress><ram:LineOne>Hauptstr. 1</ram:LineOne><ram:PostcodeCode>12345</ram:PostcodeCode><ram:CityName>Berlin</ram:CityName><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>`,
    sellerTaxRegXml = taxReg("VA", "DE123456789"),
    buyerXml = `<ram:BuyerTradeParty><ram:Name>Kunde AG</ram:Name></ram:BuyerTradeParty>`,
    paymentMeansXml = `<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE02 1234 5678 9012 3456 78</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>`,
    vatXml = `<ram:ApplicableTradeTax><ram:CalculatedAmount>38.00</ram:CalculatedAmount><ram:BasisAmount>200.00</ram:BasisAmount><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>`,
    termsXml = `<ram:SpecifiedTradePaymentTerms><ram:Description>Zahlbar innerhalb 14 Tagen</ram:Description><ram:DueDateDateTime><udt:DateTimeString format="102">20260129</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>`,
    totalsXml = `<ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>200.00</ram:LineTotalAmount><ram:TaxBasisTotalAmount>200.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">38.00</ram:TaxTotalAmount><ram:GrandTotalAmount>238.00</ram:GrandTotalAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>`,
    linesXml = lineItem(),
  } = opts;

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocument>
    <ram:ID>${invoiceNumber}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${issueDate}</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    ${linesXml}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${sellerName}</ram:Name>
        ${sellerAddressXml}
        ${sellerTaxRegXml}
      </ram:SellerTradeParty>
      ${buyerXml ?? ""}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${currency}</ram:InvoiceCurrencyCode>
      ${paymentMeansXml}
      ${vatXml}
      ${termsXml}
      ${totalsXml}
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

describe("parseCiiToEnvelope — happy path", () => {
  it("maps a minimal well-formed CII document to the envelope", () => {
    const { invoice, fieldMeta } = parseCiiToEnvelope(buildCii());

    expect(invoice.invoiceNumber).toBe("RE-2026-001");
    // format="102" is YYYYMMDD, the only date form CII actually uses on the wire.
    expect(invoice.issueDate).toBe("2026-01-15");
    expect(invoice.currency).toBe("EUR");
    expect(invoice.seller?.name).toBe("ACME Buerobedarf GmbH");
    expect(invoice.totals).toEqual({ net: "200.00", tax: "38.00", gross: "238.00" });
    expect(invoice.vatBreakdown).toEqual([{ rate: 19, net: "200.00", tax: "38.00" }]);
    expect(invoice.lineItems).toEqual([
      { position: 1, description: "Bueromaterial", quantity: "2", unit: "C62", unitPrice: "100.00", taxRate: 19, lineTotal: "200.00" },
    ]);

    expect(fieldMeta["invoiceNumber"]).toEqual({ source: "zugferd", confidence: 1 });
    expect(fieldMeta["seller.name"]).toEqual({ source: "zugferd", confidence: 1 });
    expect(fieldMeta["lineItems.0"]).toEqual({ source: "zugferd", confidence: 1 });
    expect(fieldMeta["vatBreakdown.0"]).toEqual({ source: "zugferd", confidence: 1 });
  });

  it("splits a two-rate invoice (19% goods + 7% books, EN 16931 Art. 226 case) into two breakdown entries", () => {
    const linesXml =
      lineItem() +
      lineItem({
        lineId: "2",
        productXml: "<ram:Name>Fachbuch</ram:Name>",
        unitPrice: "25.00",
        taxXml: "<ram:ApplicableTradeTax><ram:RateApplicablePercent>7</ram:RateApplicablePercent></ram:ApplicableTradeTax>",
        lineTotal: "50.00",
      });
    const vatXml =
      `<ram:ApplicableTradeTax><ram:CalculatedAmount>38.00</ram:CalculatedAmount><ram:BasisAmount>200.00</ram:BasisAmount><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>` +
      `<ram:ApplicableTradeTax><ram:CalculatedAmount>3.50</ram:CalculatedAmount><ram:BasisAmount>50.00</ram:BasisAmount><ram:RateApplicablePercent>7</ram:RateApplicablePercent></ram:ApplicableTradeTax>`;

    const { invoice, fieldMeta } = parseCiiToEnvelope(buildCii({ linesXml, vatXml }));

    expect(invoice.vatBreakdown).toEqual([
      { rate: 19, net: "200.00", tax: "38.00" },
      { rate: 7, net: "50.00", tax: "3.50" },
    ]);
    expect(invoice.lineItems).toHaveLength(2);
    // no skip in this fixture, so provenance stays index-aligned for both rows.
    expect(fieldMeta["vatBreakdown.1"]?.source).toBe("zugferd");
  });
});

describe("parseCiiToEnvelope — seller tax identifiers and IBAN", () => {
  it("maps schemeID VA/FC to ustIdNr/steuernummer and strips whitespace from the VAT id", () => {
    // German invoicing software commonly groups an IBAN's digits, and some
    // ERPs do the same for the USt-IdNr — the parser must not treat that as data.
    const sellerTaxRegXml = taxReg("VA", "DE 123 456 789") + taxReg("FC", "21/815/08150");
    const { invoice } = parseCiiToEnvelope(buildCii({ sellerTaxRegXml }));
    expect(invoice.seller?.ustIdNr).toBe("DE123456789");
    expect(invoice.seller?.steuernummer).toBe("21/815/08150");
  });

  it("guesses a scheme-less registration as ustIdNr by shape alone, with no checksum check", () => {
    // "DE999999999" fails the real USt-IdNr checksum (ISO 7064 mod 11-10 does
    // not accept it), but the code only regex-matches [A-Z]{2}\w+ — so a
    // garbage-but-shaped value is accepted just the same.
    const sellerTaxRegXml = taxReg(null, "DE999999999");
    const { invoice } = parseCiiToEnvelope(buildCii({ sellerTaxRegXml }));
    expect(invoice.seller?.ustIdNr).toBe("DE999999999");
  });

  it("does not guess a digit-only scheme-less registration (Steuernummer shape) as ustIdNr", () => {
    const sellerTaxRegXml = taxReg(null, "21/815/08150");
    const { invoice, fieldMeta } = parseCiiToEnvelope(buildCii({ sellerTaxRegXml }));
    expect(invoice.seller?.ustIdNr).toBeNull();
    expect(fieldMeta["seller.ustIdNr"]).toBeUndefined();
  });

  it("normalizes IBAN whitespace and case", () => {
    const paymentMeansXml = `<ram:SpecifiedTradeSettlementPaymentMeans><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>de02 1234 5678 9012 3456 78</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>`;
    const { invoice, fieldMeta } = parseCiiToEnvelope(buildCii({ paymentMeansXml }));
    expect(invoice.seller?.ibans).toEqual(["DE02123456789012345678"]);
    expect(fieldMeta["seller.ibans"]?.source).toBe("zugferd");
  });
});

describe("parseCiiToEnvelope — buyer", () => {
  it("maps buyer name and ID, but silently drops the buyer's postal address", () => {
    // EN 16931 BG-8 (buyer postal address) is a real, populated block on most
    // XRechnung invoices — losing it is invisible unless asserted explicitly.
    const buyerXml = `<ram:BuyerTradeParty><ram:Name>Kunde AG</ram:Name><ram:ID>K-1</ram:ID><ram:PostalTradeAddress><ram:LineOne>Kundenweg 2</ram:LineOne><ram:CityName>Hamburg</ram:CityName><ram:PostcodeCode>20095</ram:PostcodeCode><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress></ram:BuyerTradeParty>`;
    const { invoice, fieldMeta } = parseCiiToEnvelope(buildCii({ buyerXml }));
    expect(invoice.buyer).toEqual({ name: "Kunde AG", customerNumber: "K-1" });
    expect(invoice.buyer).not.toHaveProperty("address");
    // Not one of the numbered known bugs, but real: unlike seller.name, no
    // provenance entry is ever recorded for any buyer field.
    expect(fieldMeta["buyer.name"]).toBeUndefined();
  });
});

describe("parseCiiToEnvelope — num() strictness", () => {
  it("rejects a leading '+' sign even though it is valid in EN ISO 20022 amount grammars", () => {
    const linesXml = lineItem({ unitPrice: "+119.00" });
    const { invoice } = parseCiiToEnvelope(buildCii({ linesXml }));
    expect(invoice.lineItems?.[0]?.unitPrice).toBeNull();
  });

  it("rejects scientific notation", () => {
    const linesXml = lineItem({ lineTotal: "1.19E2" });
    const { invoice } = parseCiiToEnvelope(buildCii({ linesXml }));
    expect(invoice.lineItems?.[0]?.lineTotal).toBeNull();
  });

  it("accepts a plain negative amount (credit note line)", () => {
    const linesXml = lineItem({ unitPrice: "-50.00" });
    const { invoice } = parseCiiToEnvelope(buildCii({ linesXml }));
    expect(invoice.lineItems?.[0]?.unitPrice).toBe("-50.00");
  });
});

describe("parseCiiToEnvelope — malformed input throws (Path A must fail closed into Path B)", () => {
  it("throws on truncated XML", () => {
    const xml = buildCii();
    expect(() => parseCiiToEnvelope(xml.slice(0, 300))).toThrow(/malformed CII XML/);
  });

  it("throws on a well-formed but non-CII root element", () => {
    expect(() => parseCiiToEnvelope("<foo>not cii</foo>")).toThrow(/CrossIndustryInvoice/);
  });

  it("throws on an empty string", () => {
    expect(() => parseCiiToEnvelope("")).toThrow(/malformed CII XML/);
  });

  it("throws when CrossIndustryInvoice is present but its required children are missing", () => {
    // A childless root element parses to an empty string, not an object, and
    // would instead hit the "missing root" branch — so give it one unrelated
    // child to reach the ExchangedDocument/SupplyChainTradeTransaction check.
    const xml = `<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"><rsm:ExchangedDocumentContext/></rsm:CrossIndustryInvoice>`;
    expect(() => parseCiiToEnvelope(xml)).toThrow(/ExchangedDocument\/SupplyChainTradeTransaction/);
  });
});

describe("parseCiiToEnvelope — missing optional blocks", () => {
  it("leaves buyer, paymentTerms and dueDate unset when the source document omits them", () => {
    const { invoice } = parseCiiToEnvelope(buildCii({ buyerXml: null, termsXml: "" }));
    expect(invoice.buyer).toBeUndefined();
    expect(invoice.paymentTerms).toBeUndefined();
    expect(invoice.dueDate).toBeUndefined();
  });

  it("still resolves a line description via IncludedNote/Content when SpecifiedTradeProduct/Name is absent", () => {
    // The two INTENDED fallback sources for a description (Name, then
    // IncludedNote) both work; only the third real-world source — Description — doesn't (INVEX-025 below).
    const linesXml = lineItem({ productXml: "", noteXml: "<ram:Content>Sonderanfertigung</ram:Content>" });
    const { invoice } = parseCiiToEnvelope(buildCii({ linesXml }));
    expect(invoice.lineItems?.[0]?.description).toBe("Sonderanfertigung");
  });
});

describe("parseCiiToEnvelope — known bugs", () => {
  describe("INVEX-023 — fieldMeta index desync after a skipped element", () => {
    it("[current] a skipped line item shifts fieldMeta off by one for every line after it", () => {
      const linesXml =
        lineItem({ productXml: "", noteXml: "" }) + // no Name, no Note -> silently skipped
        lineItem({ lineId: "2", productXml: "<ram:Name>Kabel</ram:Name>" });
      const { invoice, fieldMeta } = parseCiiToEnvelope(buildCii({ linesXml }));

      expect(invoice.lineItems).toHaveLength(1);
      expect(invoice.lineItems?.[0]?.description).toBe("Kabel");
      // "Kabel" landed at destination index 0, but meta() was keyed on the
      // SOURCE xml index (1) — so its provenance is recorded under the wrong key.
      expect(fieldMeta["lineItems.0"]).toBeUndefined();
      expect(fieldMeta["lineItems.1"]).toBeDefined();
    });

    knownBug("INVEX-023", "lineItems fieldMeta desyncs after a skipped line").it(
      "keys fieldMeta by the surviving line's own array position",
      () => {
        const linesXml = lineItem({ productXml: "", noteXml: "" }) + lineItem({ lineId: "2", productXml: "<ram:Name>Kabel</ram:Name>" });
        const { fieldMeta } = parseCiiToEnvelope(buildCii({ linesXml }));
        expect(fieldMeta["lineItems.0"]).toBeDefined();
      },
    );

    it("[current] the same off-by-one desync hits vatBreakdown when a tax entry is skipped", () => {
      // An empty self-closing ApplicableTradeTax (seen from ERPs that emit a
      // placeholder VAT category row) parses to "" rather than a node, so it
      // is skipped just like an empty line item.
      const vatXml = `<ram:ApplicableTradeTax/>${`<ram:ApplicableTradeTax><ram:RateApplicablePercent>19</ram:RateApplicablePercent><ram:BasisAmount>200.00</ram:BasisAmount><ram:CalculatedAmount>38.00</ram:CalculatedAmount></ram:ApplicableTradeTax>`}`;
      const { invoice, fieldMeta } = parseCiiToEnvelope(buildCii({ vatXml }));

      expect(invoice.vatBreakdown).toHaveLength(1);
      expect(fieldMeta["vatBreakdown.0"]).toBeUndefined();
      expect(fieldMeta["vatBreakdown.1"]).toBeDefined();
    });

    knownBug("INVEX-023", "vatBreakdown fieldMeta desyncs after a skipped tax entry").it(
      "keys fieldMeta by the surviving entry's own array position",
      () => {
        const vatXml = `<ram:ApplicableTradeTax/>${`<ram:ApplicableTradeTax><ram:RateApplicablePercent>19</ram:RateApplicablePercent><ram:BasisAmount>200.00</ram:BasisAmount><ram:CalculatedAmount>38.00</ram:CalculatedAmount></ram:ApplicableTradeTax>`}`;
        const { fieldMeta } = parseCiiToEnvelope(buildCii({ vatXml }));
        expect(fieldMeta["vatBreakdown.0"]).toBeDefined();
      },
    );
  });

  describe("INVEX-024 — repeated elements silently become null (array-blindness)", () => {
    it("[current] a per-currency-repeated TaxTotalAmount (EXTENDED profile) makes totals.tax null", () => {
      const totalsXml = `<ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:TaxBasisTotalAmount>200.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">38.00</ram:TaxTotalAmount><ram:TaxTotalAmount currencyID="USD">42.56</ram:TaxTotalAmount><ram:GrandTotalAmount>238.00</ram:GrandTotalAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>`;
      const { invoice, fieldMeta } = parseCiiToEnvelope(buildCii({ totalsXml }));
      expect(invoice.totals?.tax).toBeNull();
      expect(fieldMeta["totals.tax"]).toBeUndefined();
    });

    knownBug("INVEX-024", "repeated TaxTotalAmount (multi-currency) is silently dropped").it(
      "still recovers the declared tax total in the invoice's own currency",
      () => {
        const totalsXml = `<ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:TaxBasisTotalAmount>200.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">38.00</ram:TaxTotalAmount><ram:TaxTotalAmount currencyID="USD">42.56</ram:TaxTotalAmount><ram:GrandTotalAmount>238.00</ram:GrandTotalAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>`;
        const { invoice } = parseCiiToEnvelope(buildCii({ totalsXml }));
        expect(invoice.totals?.tax).toBe("38.00");
      },
    );

    it("[current] a duplicated line-level ApplicableTradeTax makes taxRate null instead of picking one", () => {
      const linesXml = lineItem({
        taxXml:
          "<ram:ApplicableTradeTax><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>" +
          "<ram:ApplicableTradeTax><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>",
      });
      const { invoice } = parseCiiToEnvelope(buildCii({ linesXml }));
      expect(invoice.lineItems?.[0]?.taxRate).toBeNull();
    });

    knownBug("INVEX-024", "repeated line-level ApplicableTradeTax is silently dropped").it(
      "still recovers the line's tax rate",
      () => {
        const linesXml = lineItem({
          taxXml:
            "<ram:ApplicableTradeTax><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>" +
            "<ram:ApplicableTradeTax><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>",
        });
        const { invoice } = parseCiiToEnvelope(buildCii({ linesXml }));
        expect(invoice.lineItems?.[0]?.taxRate).toBe(19);
      },
    );

    it("[current] a payment means with two PayeePartyCreditorFinancialAccount entries yields no IBAN at all", () => {
      // Not hypothetical: SEPA + non-SEPA settlement accounts on one payment
      // means block are legal CII, and this is worse than array-blindness —
      // at() short-circuits on the array before even reaching IBANID.
      const paymentMeansXml = `<ram:SpecifiedTradeSettlementPaymentMeans><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE1111111111111111111111</ram:IBANID></ram:PayeePartyCreditorFinancialAccount><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE2222222222222222222222</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>`;
      const { invoice } = parseCiiToEnvelope(buildCii({ paymentMeansXml }));
      expect(invoice.seller?.ibans).toEqual([]);
    });

    knownBug("INVEX-024", "repeated PayeePartyCreditorFinancialAccount yields no IBAN").it(
      "still recovers at least the first IBAN",
      () => {
        const paymentMeansXml = `<ram:SpecifiedTradeSettlementPaymentMeans><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE1111111111111111111111</ram:IBANID></ram:PayeePartyCreditorFinancialAccount><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE2222222222222222222222</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>`;
        const { invoice } = parseCiiToEnvelope(buildCii({ paymentMeansXml }));
        expect(invoice.seller?.ibans).toContain("DE1111111111111111111111");
      },
    );
  });

  describe("INVEX-025 — a Description-only line item is dropped entirely", () => {
    it("[current] SpecifiedTradeProduct/Description alone (no Name, no IncludedNote) drops the whole line", () => {
      const linesXml = lineItem({ productXml: "<ram:Description>Ersatzteil fuer Pumpe XYZ</ram:Description>" });
      const { invoice } = parseCiiToEnvelope(buildCii({ linesXml }));
      // Not merely a null description — the line vanishes, so downstream the
      // line-sum reconciliation is short one row with no trace of why.
      expect(invoice.lineItems).toBeUndefined();
    });

    knownBug("INVEX-025", "a Description-only line item is dropped instead of using Description").it(
      "keeps the line, using Description as the fallback description",
      () => {
        const linesXml = lineItem({ productXml: "<ram:Description>Ersatzteil fuer Pumpe XYZ</ram:Description>" });
        const { invoice } = parseCiiToEnvelope(buildCii({ linesXml }));
        expect(invoice.lineItems).toHaveLength(1);
        expect(invoice.lineItems?.[0]?.description).toBe("Ersatzteil fuer Pumpe XYZ");
      },
    );
  });
});

describe("parseCiiToEnvelope — buyer provenance", () => {
  knownBug("INVEX-035", "buyer fields are extracted but never given a fieldMeta entry")
    .it("records provenance for the buyer name like every other extracted field", () => {
      // Every seller and totals field calls meta(); the buyer block never does.
      // Provenance is what the review UI anchors on and what confidence scoring
      // reads, so buyer data arrives with no source attribution even when it was
      // read cleanly from the XML.
      const env = parseCiiToEnvelope(buildCii());
      expect(env.invoice.buyer?.name).toBe("Kunde AG");
      expect(env.fieldMeta["buyer.name"]).toBeDefined();
    });
});
