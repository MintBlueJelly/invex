import { computeInvoice, type InvoiceSpec } from "./spec";

/** Minimal EN 16931-shaped UN/CEFACT CII serialization (Factur-X style). */
export function serializeCii(spec: InvoiceSpec): string {
  const inv = computeInvoice(spec);
  const s = spec.seller;
  const esc = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dateCii = (iso: string) => iso.replaceAll("-", "");

  const lineXml = inv.lines
    .map(
      (l) => `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${l.position}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${esc(l.description)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${l.unitPrice}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${l.unit ?? "C62"}">${l.quantity}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>${l.taxRate}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${l.lineTotal}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`,
    )
    .join("");

  const vatXml = inv.vat
    .map(
      (v) => `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${v.tax}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>${v.net}</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>${v.rate}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${esc(spec.invoiceNumber)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${dateCii(spec.issueDate)}</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${lineXml}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${esc(s.name)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${s.postalCode ?? ""}</ram:PostcodeCode>
          <ram:LineOne>${esc(s.street ?? "")}</ram:LineOne>
          <ram:CityName>${esc(s.city ?? "")}</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        ${s.ustIdNr ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${s.ustIdNr}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
        ${s.steuernummer ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${s.steuernummer}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${esc(spec.buyerName ?? "Kunde")}</ram:Name>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${inv.currency}</ram:InvoiceCurrencyCode>
      ${s.iban ? `<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${s.iban}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>` : ""}${vatXml}
      ${spec.paymentTerms || spec.dueDate ? `<ram:SpecifiedTradePaymentTerms>${spec.paymentTerms ? `<ram:Description>${esc(spec.paymentTerms)}</ram:Description>` : ""}${spec.dueDate ? `<ram:DueDateDateTime><udt:DateTimeString format="102">${dateCii(spec.dueDate)}</udt:DateTimeString></ram:DueDateDateTime>` : ""}</ram:SpecifiedTradePaymentTerms>` : ""}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${inv.totals.net}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${inv.totals.net}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${inv.currency}">${inv.totals.tax}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${inv.totals.gross}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${inv.totals.gross}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}
