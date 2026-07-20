import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { computeInvoice, type InvoiceSpec } from "./spec";
import { deDate, deMoney } from "./textPdf";

/**
 * Image-only "scan": the invoice is RENDERED to a bitmap and embedded as a
 * full-page image — zero text layer, so triage must route it to Path C.
 */
export async function makeScannedPdf(spec: InvoiceSpec): Promise<Uint8Array> {
  const inv = computeInvoice(spec);
  const s = spec.seller;
  const W = 1240; // A4 @ 150 DPI
  const H = 1754;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1a1a1a";

  const text = (t: string, x: number, y: number, size = 22, bold = false) => {
    ctx.font = `${bold ? "bold " : ""}${size}px sans-serif`;
    ctx.fillText(t, x, y);
  };

  let y = 120;
  text(s.name, 100, y, 28, true);
  y += 30;
  if (s.street) { text(s.street, 100, y); y += 26; }
  if (s.postalCode || s.city) { text(`${s.postalCode ?? ""} ${s.city ?? ""}`.trim(), 100, y); y += 26; }
  if (s.ustIdNr) { text(`USt-IdNr.: ${s.ustIdNr}`, 100, y); y += 26; }
  if (s.iban) { text(`IBAN: ${s.iban}`, 100, y); y += 26; }

  text("Rechnung", 800, 120, 40, true);
  text(`Rechnungs-Nr.: ${spec.invoiceNumber}`, 800, 175);
  text(`Rechnungsdatum: ${deDate(spec.issueDate)}`, 800, 205);

  // Table
  let ty = 480;
  const cols = [100, 170, 700, 850, 1030];
  const headers = ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"];
  headers.forEach((h, i) => text(h, cols[i]!, ty, 22, true));
  ty += 12;
  ctx.fillRect(100, ty, 1040, 2);
  ty += 34;
  for (const l of inv.lines) {
    text(String(l.position), cols[0]!, ty);
    text(l.description.slice(0, 40), cols[1]!, ty);
    text(deMoney(l.quantity).replace(",00", ""), cols[2]!, ty);
    text(deMoney(l.unitPrice), cols[3]!, ty);
    text(deMoney(l.lineTotal), cols[4]!, ty);
    ty += 32;
  }
  ctx.fillRect(100, ty, 1040, 2);
  ty += 40;
  text(`Zwischensumme (netto): ${deMoney(inv.totals.net)} EUR`, 700, ty);
  ty += 30;
  for (const v of inv.vat) {
    text(`MwSt. ${v.rate}%: ${deMoney(v.tax)} EUR`, 700, ty);
    ty += 30;
  }
  text(`Gesamtbetrag: ${deMoney(inv.totals.gross)} EUR`, 700, ty, 24, true);

  const png = canvas.toBuffer("image/png");
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  return doc.save();
}
