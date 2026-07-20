import { XMLParser, XMLValidator } from "fast-xml-parser";
import type {
  CandidateInvoice,
  CandidateLineItem,
  CandidateVatEntry,
  ExtractionEnvelope,
  FieldMeta,
} from "../schema/candidate";

/**
 * UN/CEFACT CII (ZUGfERD / Factur-X) → extraction envelope. Deliberately a
 * direct, namespace-tolerant mapping (no Schematron — briefing §9); malformed
 * input THROWS and the caller degrades gracefully to the text path (§2 Path A).
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  // Keep everything as strings — numeric tag coercion would go through float.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type Node = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Extract the text of a node that may be a string or { "#text": ... }. */
function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "object" && v !== null && "#text" in v) {
    return text((v as Node)["#text"]);
  }
  return null;
}

function node(v: unknown): Node | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Node) : null;
}

function at(root: Node | null, ...path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    const n = node(cur);
    if (!n) return undefined;
    cur = n[key];
  }
  return cur;
}

/** CII 102-format date (YYYYMMDD) → ISO. */
function ciiDate(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(s);
  return iso ? iso[0] : null;
}

function num(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  // CII amounts are dot-decimal already; guard against anything else.
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

function rate(v: unknown): number | null {
  const s = num(v);
  return s === null ? null : Number(s);
}

export function parseCiiToEnvelope(xml: string): ExtractionEnvelope {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`malformed CII XML: ${validation.err.msg} (line ${validation.err.line})`);
  }
  const doc = parser.parse(xml) as Node;
  const root = node(doc["CrossIndustryInvoice"]);
  if (!root) throw new Error("not a CII document: missing CrossIndustryInvoice root");

  const exchanged = node(at(root, "ExchangedDocument"));
  const transaction = node(at(root, "SupplyChainTradeTransaction"));
  if (!exchanged || !transaction) {
    throw new Error("CII document missing ExchangedDocument/SupplyChainTradeTransaction");
  }
  const agreement = node(at(transaction, "ApplicableHeaderTradeAgreement"));
  const settlement = node(at(transaction, "ApplicableHeaderTradeSettlement"));

  const invoice: CandidateInvoice = {};
  const fieldMeta: Record<string, FieldMeta> = {};
  const meta = (path: string, rawText?: string) => {
    fieldMeta[path] = { source: "zugferd", confidence: 1, ...(rawText ? { rawText } : {}) };
  };

  invoice.invoiceNumber = text(at(exchanged, "ID"));
  if (invoice.invoiceNumber) meta("invoiceNumber");
  invoice.issueDate = ciiDate(at(exchanged, "IssueDateTime", "DateTimeString"));
  if (invoice.issueDate) meta("issueDate");

  // Seller
  const seller = node(at(agreement, "SellerTradeParty"));
  if (seller) {
    const regs = asArray(at(seller, "SpecifiedTaxRegistration")).map(node);
    let ustIdNr: string | null = null;
    let steuernummer: string | null = null;
    for (const reg of regs) {
      const id = reg ? reg["ID"] : undefined;
      const idNode = node(id);
      const scheme = idNode ? text(idNode["@_schemeID"]) : null;
      const value = text(id);
      if (!value) continue;
      if (scheme === "VA") ustIdNr = value.replace(/\s+/g, "");
      else if (scheme === "FC") steuernummer = value;
      else if (ustIdNr === null && /^[A-Z]{2}\w+$/.test(value.replace(/\s+/g, ""))) {
        ustIdNr = value.replace(/\s+/g, "");
      }
    }
    const addr = node(at(seller, "PostalTradeAddress"));
    invoice.seller = {
      name: text(at(seller, "Name")),
      ustIdNr,
      steuernummer,
      ibans: [],
      address: addr
        ? {
            street: text(at(addr, "LineOne")),
            postalCode: text(at(addr, "PostcodeCode")),
            city: text(at(addr, "CityName")),
            countryCode: text(at(addr, "CountryID")),
          }
        : null,
    };
    meta("seller.name");
    if (ustIdNr) meta("seller.ustIdNr");
    if (steuernummer) meta("seller.steuernummer");
  }

  // Buyer
  const buyer = node(at(agreement, "BuyerTradeParty"));
  if (buyer) {
    invoice.buyer = { name: text(at(buyer, "Name")), customerNumber: text(at(buyer, "ID")) };
  }

  // Settlement: currency, IBANs, VAT breakdown, totals, terms
  if (settlement) {
    invoice.currency = text(at(settlement, "InvoiceCurrencyCode"));
    if (invoice.currency) meta("currency");

    const ibans: string[] = [];
    for (const means of asArray(at(settlement, "SpecifiedTradeSettlementPaymentMeans"))) {
      const iban = text(at(node(means), "PayeePartyCreditorFinancialAccount", "IBANID"));
      if (iban) ibans.push(iban.replace(/\s+/g, "").toUpperCase());
    }
    if (ibans.length > 0 && invoice.seller) {
      invoice.seller.ibans = ibans;
      meta("seller.ibans");
    }

    const vat: CandidateVatEntry[] = [];
    asArray(at(settlement, "ApplicableTradeTax")).forEach((t, i) => {
      const n = node(t);
      if (!n) return;
      vat.push({
        rate: rate(at(n, "RateApplicablePercent")),
        net: num(at(n, "BasisAmount")),
        tax: num(at(n, "CalculatedAmount")),
      });
      meta(`vatBreakdown.${i}`);
    });
    if (vat.length > 0) invoice.vatBreakdown = vat;

    const terms = node(at(settlement, "SpecifiedTradePaymentTerms"));
    if (terms) {
      invoice.paymentTerms = text(at(terms, "Description"));
      invoice.dueDate = ciiDate(at(terms, "DueDateDateTime", "DateTimeString"));
    }

    const sums = node(at(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation"));
    if (sums) {
      const net = num(at(sums, "TaxBasisTotalAmount")) ?? num(at(sums, "LineTotalAmount"));
      const tax = num(at(sums, "TaxTotalAmount"));
      const gross = num(at(sums, "GrandTotalAmount"));
      invoice.totals = { net, tax, gross };
      if (net) meta("totals.net");
      if (tax) meta("totals.tax");
      if (gross) meta("totals.gross");
    }
  }

  // Line items
  const lines: CandidateLineItem[] = [];
  asArray(at(transaction, "IncludedSupplyChainTradeLineItem")).forEach((l, i) => {
    const n = node(l);
    if (!n) return;
    const description =
      text(at(n, "SpecifiedTradeProduct", "Name")) ??
      text(at(n, "AssociatedDocumentLineDocument", "IncludedNote", "Content"));
    if (!description) return;
    const posText = text(at(n, "AssociatedDocumentLineDocument", "LineID"));
    const qty = at(n, "SpecifiedLineTradeDelivery", "BilledQuantity");
    const qtyNode = node(qty);
    lines.push({
      position: posText && /^\d+$/.test(posText) ? Number(posText) : null,
      description,
      quantity: num(qty),
      unit: qtyNode ? text(qtyNode["@_unitCode"]) : null,
      unitPrice:
        num(at(n, "SpecifiedLineTradeAgreement", "NetPriceProductTradePrice", "ChargeAmount")) ??
        num(at(n, "SpecifiedLineTradeAgreement", "GrossPriceProductTradePrice", "ChargeAmount")),
      taxRate: rate(at(n, "SpecifiedLineTradeSettlement", "ApplicableTradeTax", "RateApplicablePercent")),
      lineTotal: num(
        at(n, "SpecifiedLineTradeSettlement", "SpecifiedTradeSettlementLineMonetarySummation", "LineTotalAmount"),
      ),
    });
    meta(`lineItems.${i}`);
  });
  if (lines.length > 0) invoice.lineItems = lines;

  return { invoice, fieldMeta };
}
