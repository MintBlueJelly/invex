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
    invoiceNumber: {
      labels: [
        "Rechnungsnummer", "Rechnungs-Nr", "Rechnung Nr", "Rechnungsnr", "RE-Nr", "Re.-Nr",
        "Beleg-Nr", "Belegnummer", "Invoice No", "Invoice Number", "Invoice #", "Rechnung",
      ],
      // Must contain a digit; tolerates letter-dash prefixes ("R-A-1", "RE/2026/17").
      valuePattern: "[A-Za-z0-9][A-Za-z0-9\\-/._]{0,30}\\d[\\dA-Za-z\\-/._]*",
    },
    issueDate: {
      labels: [
        "Rechnungsdatum", "Belegdatum", "Datum", "Ausstellungsdatum", "Invoice Date", "Date of Issue", "Date",
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
