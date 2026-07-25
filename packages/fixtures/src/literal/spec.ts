/**
 * A literal invoice document: EXACTLY the ink on the page, as strings.
 *
 * Nothing here is computed. Every amount, date and label is written as it is
 * printed — "1.148,70", not 1148.7; "15.06.2026", not an ISO date. The
 * generators print these verbatim.
 *
 * That is the whole point. The previous fixtures were rendered from
 * `computeInvoice()`, and `out/expected.json` was regenerated from the SAME
 * function, so the suite validated the pipeline against its own arithmetic.
 * Here the printed side and the expected canonical side are authored
 * independently, in different notations, and the pipeline is the only thing
 * claiming to connect them. That is an oracle.
 *
 * See packages/fixtures/scenarios/*.golden.json.
 */

export interface LiteralLine {
  /** Position/row number as printed, e.g. "1" or "01". Omit for unnumbered tables. */
  posText?: string;
  descriptionText: string;
  /** Wraps onto a following row with no position number — the continuation case. */
  continuationText?: string;
  quantityText?: string;
  unitText?: string;
  unitPriceText?: string;
  /** As printed, including any "%" — e.g. "19 %". */
  taxRateText?: string;
  lineTotalText?: string;
}

export interface LiteralTotalsRow {
  labelText: string;
  valueText: string;
  bold?: boolean;
}

export interface LiteralSeller {
  nameText: string;
  /** Street, then "PLZ Ort" — printed as separate lines. */
  addressLines: string[];
  /** e.g. "USt-IdNr.: DE811907980" */
  taxIdLine?: string;
  /** e.g. "Steuernummer: 143/824/61903" */
  steuernummerLine?: string;
  /** e.g. "Bankverbindung: IBAN DE02 1203 0000 0000 2020 51" */
  bankLines?: string[];
}

export interface LiteralInvoiceDoc {
  /** Drives nothing in layout; it documents which notation the strings use. */
  locale: "de" | "en";
  seller: LiteralSeller;
  buyerLines?: string[];
  /** Document heading, e.g. "Rechnung" / "Invoice" / "Gutschrift". */
  headingText: string;
  /** Label/value pairs in the top-right block, printed in order. */
  headerFields: { labelText: string; valueText: string }[];
  tableHeaders: string[];
  /**
   * What each table column holds, parallel to `tableHeaders`. Explicit rather
   * than positional: a table with only "Pos / Bezeichnung / Gesamt" has no
   * quantity or unit-price column at all, and inferring that from position
   * silently puts the line total under the wrong header.
   */
  tableColumns: ("position" | "description" | "quantity" | "unit" | "unitPrice" | "taxRate" | "lineTotal")[];
  lines: LiteralLine[];
  totalsBlock: LiteralTotalsRow[];
  /** Legal notes: §19 UStG, §13b reverse charge, payment terms. */
  noteLines?: string[];
  footerLines?: string[];
}
