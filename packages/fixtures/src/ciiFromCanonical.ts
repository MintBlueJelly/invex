import type { CanonicalInvoice } from "@invex/core";

/**
 * Serialize a hand-authored CanonicalInvoice to EN 16931 CII XML.
 *
 * Deliberately distinct from `serializeCii(spec)`, which calls
 * `computeInvoice()` and therefore makes a round-trip test compare the parser
 * against the same arithmetic that produced its input. Here the input is a
 * golden's independently authored canonical invoice, so a round-trip actually
 * says something about `parseCiiToEnvelope`.
 *
 * Nothing is computed: every value is copied from the canonical as-is.
 *
 * The `defects` options build the malformed documents real ZUGfERD produces —
 * they exist so the parser's failure modes can be tested without hand-typing
 * a whole second XML document per case.
 */

export interface CiiDefects {
  /**
   * Emit one `TaxTotalAmount` per currency, as ZUGfERD EXTENDED legitimately
   * does. fast-xml-parser then yields an array (INVEX-024).
   */
  repeatTaxTotal?: boolean;
  /** 1-based line numbers whose product Name is omitted, so the parser skips them. */
  omitLineNames?: number[];
  /**
   * Put a line's description ONLY in SpecifiedTradeProduct/Description, which
   * the parser does not read (INVEX-025).
   */
  descriptionOnlyFor?: number[];
  /** Truncate the output, for the graceful-fallthrough path. */
  truncateAt?: number;
}

const esc = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ciiDate = (iso: string): string => iso.replaceAll("-", "");

export function serializeCiiFromCanonical(inv: CanonicalInvoice, defects: CiiDefects = {}): string {
  const omitNames = new Set(defects.omitLineNames ?? []);
  const descOnly = new Set(defects.descriptionOnlyFor ?? []);

  const lines = inv.lineItems
    .map((l, i) => {
      const n = i + 1;
      const name = omitNames.has(n)
        ? ""
        : descOnly.has(n)
          ? `<ram:Description>${esc(l.description)}</ram:Description>`
          : `<ram:Name>${esc(l.description)}</ram:Name>`;
      // unitCode only when the canonical declares one: EN 16931 wants it, but
      // inventing "C62" here would make the round trip assert a unit the golden
      // never claimed, and the printed page has no unit column.
      const qty =
        l.quantity === null
          ? ""
          : l.unit === null
            ? `<ram:BilledQuantity>${l.quantity}</ram:BilledQuantity>`
            : `<ram:BilledQuantity unitCode="${esc(l.unit)}">${l.quantity}</ram:BilledQuantity>`;
      const price =
        l.unitPrice === null
          ? ""
          : `<ram:NetPriceProductTradePrice><ram:ChargeAmount>${l.unitPrice}</ram:ChargeAmount></ram:NetPriceProductTradePrice>`;
      const rate =
        l.taxRate === null
          ? ""
          : `<ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>${l.taxRate}</ram:RateApplicablePercent></ram:ApplicableTradeTax>`;
      const total =
        l.lineTotal === null
          ? ""
          : `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${l.lineTotal}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>`;
      return `
      <ram:IncludedSupplyChainTradeLineItem>
        <ram:AssociatedDocumentLineDocument><ram:LineID>${l.position ?? n}</ram:LineID></ram:AssociatedDocumentLineDocument>
        <ram:SpecifiedTradeProduct>${name}</ram:SpecifiedTradeProduct>
        <ram:SpecifiedLineTradeAgreement>${price}</ram:SpecifiedLineTradeAgreement>
        <ram:SpecifiedLineTradeDelivery>${qty}</ram:SpecifiedLineTradeDelivery>
        <ram:SpecifiedLineTradeSettlement>${rate}${total}</ram:SpecifiedLineTradeSettlement>
      </ram:IncludedSupplyChainTradeLineItem>`;
    })
    .join("");

  const registrations = [
    inv.seller.ustIdNr ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(inv.seller.ustIdNr)}</ram:ID></ram:SpecifiedTaxRegistration>` : "",
    inv.seller.steuernummer ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${esc(inv.seller.steuernummer)}</ram:ID></ram:SpecifiedTaxRegistration>` : "",
  ].join("");

  const ibans = inv.seller.ibans
    .map(
      (iban) =>
        `<ram:SpecifiedTradeSettlementPaymentMeans><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${esc(iban)}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>`,
    )
    .join("");

  const taxes = inv.vatBreakdown
    .map(
      (v) =>
        `<ram:ApplicableTradeTax><ram:CalculatedAmount>${v.tax}</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>${v.net}</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>${v.rate}</ram:RateApplicablePercent></ram:ApplicableTradeTax>`,
    )
    .join("");

  const taxTotal = defects.repeatTaxTotal
    ? `<ram:TaxTotalAmount currencyID="${inv.currency}">${inv.totals.tax}</ram:TaxTotalAmount>` +
      `<ram:TaxTotalAmount currencyID="EUR">${inv.totals.tax}</ram:TaxTotalAmount>`
    : `<ram:TaxTotalAmount currencyID="${inv.currency}">${inv.totals.tax}</ram:TaxTotalAmount>`;

  const dueDate = inv.dueDate
    ? `<ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">${ciiDate(inv.dueDate)}</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>`
    : "";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocument>
    <ram:ID>${esc(inv.invoiceNumber)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${ciiDate(inv.issueDate)}</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${lines}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${esc(inv.seller.name)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(inv.seller.address?.postalCode ?? "")}</ram:PostcodeCode>
          <ram:LineOne>${esc(inv.seller.address?.street ?? "")}</ram:LineOne>
          <ram:CityName>${esc(inv.seller.address?.city ?? "")}</ram:CityName>
        </ram:PostalTradeAddress>${registrations}
      </ram:SellerTradeParty>
      ${inv.buyer?.name ? `<ram:BuyerTradeParty><ram:Name>${esc(inv.buyer.name)}</ram:Name></ram:BuyerTradeParty>` : ""}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${inv.currency}</ram:InvoiceCurrencyCode>${ibans}${taxes}${dueDate}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${inv.totals.net}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${inv.totals.net}</ram:TaxBasisTotalAmount>
        ${taxTotal}
        <ram:GrandTotalAmount>${inv.totals.gross}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${inv.totals.gross}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

  return defects.truncateAt === undefined ? xml : `${xml.slice(0, defects.truncateAt)}<ram:Broken`;
}
