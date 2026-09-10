/**
 * Multilingual label-synonym lexicon for the generic rule engine (briefing §3).
 * Escalation logs (§8: which rule found no anchor) drive additions here.
 */

export interface HeaderLexiconEntry {
  labels: string[];
  /** Regex source applied to the text after the label. */
  valuePattern?: string;
}

export interface Lexicon {
  header: Record<
    "invoiceNumber" | "issueDate" | "dueDate" | "totals.net" | "totals.tax" | "totals.gross",
    HeaderLexiconEntry
  >;
  table: Record<
    "position" | "description" | "quantity" | "unit" | "unitPrice" | "taxRate" | "lineTotal",
    string[]
  >;
}

const AMOUNT = "-?[\\d.,]+";
const DATE = "\\d{1,4}[./-]\\s?\\d{1,2}[./-]\\s?\\d{1,4}";

export const defaultLexicon: Lexicon = {
  header: {
    // The KEY is template/lexicon vocabulary and deliberately did not follow the
    // canonical schema's v2 rename; it maps to invoice.documentNumber via
    // template/apply.ts setField. The labels cover every document class, since
    // an Auftragsbestätigung's number is the same field to everything
    // downstream. Longer labels first: findLabelHits takes the first match, and
    // "Rechnung" would otherwise swallow "Rechnungsnummer".
    invoiceNumber: {
      labels: [
        "Rechnungsnummer", "Rechnungs-Nr", "Rechnung Nr", "Rechnungsnr", "RE-Nr", "Re.-Nr",
        "Auftragsbestätigungs-Nr", "Auftragsbestätigungsnummer", "Bestellbestätigungs-Nr",
        "Auftragsnummer", "Auftrags-Nr", "AB-Nr",
        "Lieferscheinnummer", "Lieferschein-Nr", "LS-Nr",
        "Angebotsnummer", "Angebots-Nr", "Gutschriftsnummer", "Gutschrift-Nr", "GS-Nr",
        "Bestellnummer", "Bestell-Nr", "Vorgangsnummer", "Vorgangs-Nr", "Dokumentnummer",
        "Beleg-Nr", "Belegnummer",
        "Order No", "Order Number", "Delivery Note No", "Quotation No", "Credit Note No",
        "Invoice No", "Invoice Number", "Invoice #", "Rechnung",
      ],
      // Must contain a digit; tolerates letter-dash prefixes ("R-A-1", "RE/2026/17").
      valuePattern: "[A-Za-z0-9][A-Za-z0-9\\-/._]{0,30}\\d[\\dA-Za-z\\-/._]*",
    },
    // Maps to invoice.documentDate. Bare "Datum"/"Date" stay LAST: every class
    // prints them, so they are the fallback after a class-specific label.
    issueDate: {
      labels: [
        "Rechnungsdatum", "Belegdatum", "Ausstellungsdatum",
        "Auftragsbestätigungsdatum", "Auftragsdatum", "Bestätigungsdatum",
        "Lieferscheindatum", "Lieferdatum", "Angebotsdatum", "Gutschriftsdatum", "Bestelldatum",
        "Invoice Date", "Date of Issue", "Order Date", "Delivery Date", "Quotation Date",
        "Datum", "Date",
      ],
      valuePattern: DATE,
    },
    dueDate: {
      labels: ["Fällig am", "Fälligkeitsdatum", "Zahlbar bis", "Due Date", "Payment due"],
      valuePattern: DATE,
    },
    "totals.net": {
      labels: [
        "Zwischensumme (netto)", "Zwischensumme", "Nettobetrag", "Summe netto", "Netto",
        "Warenwert", "Subtotal", "Net Amount", "Net Total",
      ],
      valuePattern: AMOUNT,
    },
    "totals.tax": {
      labels: [
        "MwSt", "Mehrwertsteuer", "USt", "Umsatzsteuer", "zzgl. MwSt", "VAT", "Tax", "Sales Tax",
      ],
      valuePattern: AMOUNT,
    },
    "totals.gross": {
      labels: [
        "Gesamtbetrag", "Rechnungsbetrag", "Endbetrag", "Zu zahlender Betrag", "Zahlbetrag",
        "Bruttobetrag", "Summe brutto", "Gesamt", "Total", "Total Due", "Amount Due", "Grand Total",
      ],
      valuePattern: AMOUNT,
    },
  },
  table: {
    position: ["Pos", "Pos.", "Position", "Nr", "#", "Item"],
    description: ["Bezeichnung", "Beschreibung", "Artikel", "Leistung", "Posten", "Description", "Item Description", "Product"],
    quantity: ["Menge", "Anzahl", "Stück", "Stk", "Qty", "Quantity", "Units"],
    unit: ["Einheit", "ME", "Unit", "UoM"],
    unitPrice: ["Einzelpreis", "E-Preis", "Preis", "Stückpreis", "Satz", "Unit Price", "Price", "Rate"],
    taxRate: ["MwSt", "USt", "MwSt.-Satz", "St.-Satz", "Steuersatz", "VAT", "Tax Rate", "Tax %"],
    lineTotal: ["Gesamt", "Betrag", "Gesamtpreis", "Summe", "Wert", "Amount", "Total", "Line Total"],
  },
};
