import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { computeInvoice, type InvoiceSpec } from "./spec";

/**
 * Born-digital text-layer invoice PDF. Amounts and dates are printed in GERMAN
 * locale (1.234,56 / 15.06.2026) so the rule engine's locale parsing is
 * genuinely exercised. Labels are overridable to build "unknown vendor idiom"
 * fixtures that force VLM escalation.
 */

export interface TextPdfLabels {
  invoiceHeading: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: string;
  vat: string;
  total: string;
  tableHeaders: [string, string, string, string, string]; // pos, desc, qty, unitPrice, lineTotal
}

export const defaultLabels: TextPdfLabels = {
  invoiceHeading: "Rechnung",
  invoiceNumber: "Rechnungs-Nr.",
  invoiceDate: "Rechnungsdatum",
  dueDate: "Fällig am",
  subtotal: "Zwischensumme (netto)",
  vat: "MwSt.",
  total: "Gesamtbetrag",
  tableHeaders: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
};

/** German number formatting: 1.234,56 */
export function deMoney(dot: string): string {
  const [intPart = "0", frac = "00"] = dot.split(".");
  const negative = intPart.startsWith("-");
  const digits = negative ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${grouped},${frac.padEnd(2, "0")}`;
}

export function deDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

const A4: [number, number] = [595.28, 841.89];

interface Cursor {
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
}

function draw(c: Cursor, text: string, x: number, y: number, size = 10, bold = false): void {
  c.page.drawText(text, { x, y, size, font: bold ? c.bold : c.font, color: rgb(0.1, 0.1, 0.1) });
}

export async function makeTextInvoicePdf(
  spec: InvoiceSpec,
  opts?: { labels?: Partial<TextPdfLabels> },
): Promise<Uint8Array> {
  const labels: TextPdfLabels = { ...defaultLabels, ...opts?.labels };
  const inv = computeInvoice(spec);
  const s = spec.seller;

  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c: Cursor = { page, font, bold };
  const [, H] = A4;

  // Seller letterhead (top left)
  let y = H - 60;
  draw(c, s.name, 50, y, 12, true);
  y -= 14;
  if (s.street) { draw(c, s.street, 50, y); y -= 12; }
  if (s.postalCode || s.city) { draw(c, `${s.postalCode ?? ""} ${s.city ?? ""}`.trim(), 50, y); y -= 12; }
  if (s.ustIdNr) { draw(c, `USt-IdNr.: ${s.ustIdNr}`, 50, y); y -= 12; }
  if (s.steuernummer) { draw(c, `Steuernummer: ${s.steuernummer}`, 50, y); y -= 12; }

  // Invoice header block (top right)
  draw(c, labels.invoiceHeading, 380, H - 60, 18, true);
  draw(c, `${labels.invoiceNumber}: ${spec.invoiceNumber}`, 380, H - 86);
  draw(c, `${labels.invoiceDate}: ${deDate(spec.issueDate)}`, 380, H - 100);
  if (spec.dueDate) draw(c, `${labels.dueDate}: ${deDate(spec.dueDate)}`, 380, H - 114);

  // Buyer block
  draw(c, spec.buyerName ?? "Kunde", 50, H - 180, 10, true);

  // Line item table
  const cols = [50, 85, 330, 395, 480];
  let ty = H - 240;
  const headers = labels.tableHeaders;
  headers.forEach((h, i) => draw(c, h, cols[i]!, ty, 10, true));
  ty -= 6;
  page.drawLine({ start: { x: 50, y: ty }, end: { x: 545, y: ty }, thickness: 0.7, color: rgb(0.3, 0.3, 0.3) });
  ty -= 14;
  for (const l of inv.lines) {
    draw(c, String(l.position), cols[0]!, ty);
    // Long descriptions wrap onto continuation rows WITHOUT a position number —
    // the classic multi-row description case templates must handle.
    const desc = l.description;
    const firstLine = desc.length > 42 ? desc.slice(0, 42).trimEnd() : desc;
    const rest = desc.length > 42 ? desc.slice(42).trim() : null;
    draw(c, firstLine, cols[1]!, ty);
    draw(c, deMoney(l.quantity).replace(",00", ""), cols[2]!, ty);
    draw(c, deMoney(l.unitPrice), cols[3]!, ty);
    draw(c, deMoney(l.lineTotal), cols[4]!, ty);
    ty -= 14;
    if (rest) {
      draw(c, rest, cols[1]!, ty);
      ty -= 14;
    }
  }
  page.drawLine({ start: { x: 50, y: ty + 6 }, end: { x: 545, y: ty + 6 }, thickness: 0.7, color: rgb(0.3, 0.3, 0.3) });

  // Totals block (bottom right)
  let sy = ty - 16;
  draw(c, `${labels.subtotal}:`, 330, sy);
  draw(c, `${deMoney(inv.totals.net)} EUR`, 480, sy);
  sy -= 14;
  for (const v of inv.vat) {
    draw(c, `${labels.vat} ${v.rate}%:`, 330, sy);
    draw(c, `${deMoney(v.tax)} EUR`, 480, sy);
    sy -= 14;
  }
  draw(c, `${labels.total}:`, 330, sy, 11, true);
  draw(c, `${deMoney(inv.totals.gross)} EUR`, 480, sy, 11, true);
  sy -= 24;

  if (spec.paymentTerms) draw(c, spec.paymentTerms, 50, sy);
  if (s.iban) draw(c, `Bankverbindung: IBAN ${s.iban}`, 50, sy - 14);

  return doc.save();
}

/** Non-invoice letter/terms document (classifier + Markdown path fixture). */
export async function makeLetterPdf(title: string, paragraphs: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c: Cursor = { page, font, bold };
  const [, H] = A4;
  draw(c, title, 50, H - 70, 14, true);
  let y = H - 110;
  for (const p of paragraphs) {
    for (const line of wrap(p, 88)) {
      draw(c, line, 50, y);
      y -= 13;
    }
    y -= 8;
  }
  return doc.save();
}

/** Garbage text layer (simulates broken upstream OCR) — must trip the text gate. */
export async function makeGarbageTextPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c: Cursor = { page, font, bold };
  const [, H] = A4;
  let y = H - 60;
  for (let i = 0; i < 30; i++) {
    const junk = Array.from({ length: 8 }, (_, j) => `(cid:${(i * 17 + j * 31) % 255})`).join(" ");
    draw(c, junk, 50, y, 9);
    y -= 16;
    draw(c, "xq zvw kjh gfd pqz wxc vbn mlk jhg fds qaz wsx edc rfv tgb yhn ujm", 50, y, 9);
    y -= 16;
  }
  return doc.save();
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      lines.push(cur.trim());
      cur = w;
    } else {
      cur = `${cur} ${w}`;
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}
