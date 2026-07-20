/**
 * Hand-authored DoclingDocument JSON fixtures — the committed samples that pin
 * core's mapDoclingDocument (plan risk #7: swap in a captured live response on
 * a Docker-capable machine when available). Coordinates are A4 points with
 * BOTTOMLEFT origin, exactly as docling-serve emits them, so the mapper's
 * y-flip and normalization are genuinely exercised.
 */

const W = 595;
const H = 842;

export interface SpecLine {
  text: string;
  x: number;
  /** y measured from the TOP of the page (points). */
  yTop: number;
  label?: string;
  page?: number;
  w?: number;
}

export interface SpecTable {
  headers: string[];
  rows: string[][];
  yTop?: number;
  page?: number;
}

export function doclingJson(lines: SpecLine[], tables: SpecTable[] = [], pageCount = 1): unknown {
  const pages: Record<string, unknown> = {};
  for (let p = 1; p <= pageCount; p++) {
    pages[String(p)] = { size: { width: W, height: H }, page_no: p };
  }
  return {
    schema_name: "DoclingDocument",
    version: "1.0.0",
    texts: lines.map((l) => ({
      label: l.label ?? "text",
      text: l.text,
      prov: [
        {
          page_no: l.page ?? 1,
          bbox: {
            l: l.x,
            r: l.x + (l.w ?? Math.min(420, l.text.length * 5.5)),
            t: H - l.yTop,
            b: H - (l.yTop + 12),
            coord_origin: "BOTTOMLEFT",
          },
        },
      ],
    })),
    tables: tables.map((tb) => {
      const yTop = tb.yTop ?? 300;
      const numCols = tb.headers.length;
      const numRows = tb.rows.length + 1;
      const cells = [
        ...tb.headers.map((text, c) => ({
          text,
          start_row_offset_idx: 0,
          end_row_offset_idx: 1,
          start_col_offset_idx: c,
          end_col_offset_idx: c + 1,
          column_header: true,
        })),
        ...tb.rows.flatMap((row, r) =>
          row.map((text, c) => ({
            text,
            start_row_offset_idx: r + 1,
            end_row_offset_idx: r + 2,
            start_col_offset_idx: c,
            end_col_offset_idx: c + 1,
            column_header: false,
          })),
        ),
      ];
      return {
        prov: [
          {
            page_no: tb.page ?? 1,
            bbox: { l: 50, r: 545, t: H - yTop, b: H - (yTop + 30 + tb.rows.length * 16), coord_origin: "BOTTOMLEFT" },
          },
        ],
        data: { num_rows: numRows, num_cols: numCols, table_cells: cells },
      };
    }),
    pages,
  };
}

/** Standard German text invoice (matches the pdf fixture's arithmetic truth). */
export function invoiceDoclingJson(overrides?: { invoiceNumber?: string; issueDate?: string }): unknown {
  const nr = overrides?.invoiceNumber ?? "R-2026-0042";
  const date = overrides?.issueDate ?? "15.06.2026";
  return doclingJson(
    [
      { text: "ACME Bürotechnik GmbH", x: 50, yTop: 60 },
      { text: "Industriestraße 12", x: 50, yTop: 76 },
      { text: "80331 München", x: 50, yTop: 92 },
      { text: "USt-IdNr.: DE811907980", x: 50, yTop: 108 },
      { text: "Rechnung", x: 380, yTop: 60, label: "section_header" },
      { text: `Rechnungs-Nr.: ${nr}`, x: 380, yTop: 88 },
      { text: `Rechnungsdatum: ${date}`, x: 380, yTop: 104 },
      { text: "Beispiel AG", x: 50, yTop: 180 },
      { text: "Zwischensumme (netto): 1.148,70 EUR", x: 330, yTop: 600 },
      { text: "MwSt. 19%: 218,25 EUR", x: 330, yTop: 616 },
      { text: "Gesamtbetrag: 1.366,95 EUR", x: 330, yTop: 632 },
      { text: "Zahlbar innerhalb von 30 Tagen ohne Abzug.", x: 50, yTop: 664 },
      { text: "Bankverbindung: IBAN DE02120300000000202051", x: 50, yTop: 680 },
    ],
    [
      {
        yTop: 240,
        headers: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
        rows: [
          ["1", "Aktenvernichter PS-500", "2", "199,50", "399,00"],
          ["2", "Wartungsvertrag Bürogeräte, Laufzeit 12", "1", "480,00", "480,00"],
          ["", "Monate", "", "", ""],
          ["3", "Toner-Set CMYK", "3", "89,90", "269,70"],
        ],
      },
    ],
  );
}

/** Same invoice, labels alien to the lexicon → deterministic path must fail. */
export function alienLabelsDoclingJson(): unknown {
  return doclingJson(
    [
      { text: "ACME Bürotechnik GmbH", x: 50, yTop: 60 },
      { text: "USt-IdNr.: DE811907980", x: 50, yTop: 92 },
      { text: "Rechnung", x: 380, yTop: 60, label: "section_header" },
      { text: "Vorgangskennung: R-2026-0042", x: 380, yTop: 88 },
      { text: "Erstellt: 15.06.2026", x: 380, yTop: 104 },
      { text: "Basiswert: 1.148,70", x: 330, yTop: 600 },
      { text: "Abgabe 19%: 218,25", x: 330, yTop: 616 },
      { text: "Absolutwert: 1.366,95", x: 330, yTop: 632 },
    ],
    [
      {
        yTop: 240,
        headers: ["Zeile", "Text", "Vol", "Kurs", "Absolut"],
        rows: [
          ["1", "Aktenvernichter PS-500", "2", "199,50", "399,00"],
          ["2", "Wartungsvertrag", "1", "480,00", "480,00"],
          ["3", "Toner-Set CMYK", "3", "89,90", "269,70"],
        ],
      },
    ],
  );
}

/** Non-invoice: terms & conditions letter. */
export function letterDoclingJson(): unknown {
  return doclingJson([
    { text: "Allgemeine Geschäftsbedingungen", x: 50, yTop: 70, label: "section_header" },
    { text: "Die nachfolgenden Bedingungen gelten für alle Lieferungen und Leistungen.", x: 50, yTop: 110 },
    { text: "Angebote sind freibleibend und unverbindlich.", x: 50, yTop: 126 },
    { text: "Lieferfristen sind nur verbindlich, wenn sie schriftlich bestätigt wurden.", x: 50, yTop: 142 },
    { text: "Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts.", x: 50, yTop: 158 },
  ]);
}

/** Garbage text layer (broken upstream OCR): must trip the gate. */
export function garbageDoclingJson(): unknown {
  const lines: SpecLine[] = [];
  for (let i = 0; i < 20; i++) {
    lines.push({ text: `(cid:${i * 7}) (cid:${i * 11}) (cid:${i * 13}) qzwx vbnk jhgf`, x: 50, yTop: 60 + i * 16 });
  }
  return doclingJson(lines);
}

/**
 * OCR-style output for the scanned ACME invoice: WORD/FRAGMENT-level items and
 * no TableFormer tables — exactly the Path C shape (docling do_ocr=true,
 * do_table_structure=false).
 */
export function ocrInvoiceDoclingJson(): unknown {
  const w = (text: string, x: number, yTop: number): SpecLine => ({ text, x, yTop });
  return doclingJson([
    w("ACME", 50, 60), w("Bürotechnik", 90, 60), w("GmbH", 160, 60),
    w("USt-IdNr.:", 50, 108), w("DE811907980", 115, 108),
    w("Rechnung", 380, 60),
    w("Rechnungs-Nr.:", 380, 88), w("R-2026-0042", 470, 88),
    w("Rechnungsdatum:", 380, 104), w("15.06.2026", 480, 104),
    // table header + rows (no tables[] — OCR)
    w("Pos", 50, 240), w("Bezeichnung", 85, 240), w("Menge", 330, 240), w("Einzelpreis", 395, 240), w("Gesamt", 480, 240),
    w("1", 50, 262), w("Aktenvernichter", 85, 262), w("PS-500", 170, 262), w("2", 330, 262), w("199,50", 395, 262), w("399,00", 480, 262),
    w("2", 50, 280), w("Wartungsvertrag", 85, 280), w("1", 330, 280), w("480,00", 395, 280), w("480,00", 480, 280),
    w("3", 50, 298), w("Toner-Set", 85, 298), w("CMYK", 145, 298), w("3", 330, 298), w("89,90", 395, 298), w("269,70", 480, 298),
    w("Zwischensumme (netto):", 330, 600), w("1.148,70", 480, 600),
    w("MwSt. 19%:", 330, 616), w("218,25", 480, 616),
    w("Gesamtbetrag:", 330, 632), w("1.366,95", 480, 632),
  ]);
}

/** OCR output for an UNKNOWN scanned vendor (checksum-valid ids, simple totals). */
export function ocrUnknownVendorDoclingJson(): unknown {
  const w = (text: string, x: number, yTop: number): SpecLine => ({ text, x, yTop });
  return doclingJson([
    w("Muster", 50, 60), w("Verlag", 95, 60), w("GmbH", 140, 60),
    w("10115", 50, 76), w("Berlin", 85, 76),
    w("USt-IdNr.:", 50, 92), w("DE136695976", 115, 92),
    w("Rechnung", 380, 60),
    w("Rechnungs-Nr.:", 380, 120), w("RG-77", 470, 120),
    w("Rechnungsdatum:", 380, 136), w("01.06.2026", 480, 136),
    w("Pos", 50, 240), w("Bezeichnung", 85, 240), w("Menge", 330, 240), w("Einzelpreis", 395, 240), w("Gesamt", 480, 240),
    w("1", 50, 262), w("Beratung", 85, 262), w("1", 330, 262), w("100,00", 395, 262), w("100,00", 480, 262),
    w("Zwischensumme (netto):", 330, 600), w("100,00", 480, 600),
    w("MwSt. 19%:", 330, 616), w("19,00", 480, 616),
    w("Gesamtbetrag:", 330, 632), w("119,00", 480, 632),
  ]);
}

/** Two invoices in one PDF (page counter restarts) + trailing AGB page. */
export function multiInvoiceDoclingJson(): unknown {
  const invoicePage = (page: number, nr: string): SpecLine[] => [
    { text: "Rechnung", x: 380, yTop: 60, label: "section_header", page },
    { text: `Rechnungs-Nr.: ${nr}`, x: 380, yTop: 88, page },
    { text: "Rechnungsdatum: 15.06.2026", x: 380, yTop: 104, page },
    { text: "Seite 1 von 1", x: 50, yTop: 800, page },
    { text: "Gesamtbetrag: 119,00 EUR", x: 330, yTop: 632, page },
    { text: "MwSt. 19%: 19,00 EUR", x: 330, yTop: 616, page },
    { text: "Zwischensumme (netto): 100,00 EUR", x: 330, yTop: 600, page },
    { text: "USt-IdNr.: DE811907980", x: 50, yTop: 92, page },
  ];
  const lines: SpecLine[] = [
    ...invoicePage(1, "R-A-1"),
    ...invoicePage(2, "R-B-2"),
    { text: "Allgemeine Geschäftsbedingungen", x: 50, yTop: 70, label: "section_header", page: 3 },
    { text: "Es gilt deutsches Recht.", x: 50, yTop: 110, page: 3 },
  ];
  const table = (page: number): SpecTable => ({
    page,
    yTop: 240,
    headers: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
    rows: [["1", "Beratung", "1", "100,00", "100,00"]],
  });
  return doclingJson(lines, [table(1), table(2)], 3);
}
