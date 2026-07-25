import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { PageLayout } from "../layout/invoiceLayout";

/**
 * PageLayout -> a born-digital PDF, the third renderer sharing the layout's
 * geometry (alongside the Docling/OCR JSON renderers). pdf-lib draws from a
 * bottom-left origin; per invoiceLayout's convention (mirrored from
 * textPdf.ts) `yTop` already IS the baseline y, no font-ascent correction, so
 * the flip is just `heightPt - yTop`.
 */

export interface RenderPdfOptions {
  font?: "Helvetica" | "TimesRoman";
}

const FONT_FAMILIES: Record<NonNullable<RenderPdfOptions["font"]>, { regular: StandardFonts; bold: StandardFonts }> = {
  Helvetica: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold },
  TimesRoman: { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold },
};

export async function renderPdf(pages: PageLayout[], opts: RenderPdfOptions = {}): Promise<Uint8Array> {
  const family = FONT_FAMILIES[opts.font ?? "Helvetica"];
  const doc = await PDFDocument.create();
  const font: PDFFont = await doc.embedFont(family.regular);
  const bold: PDFFont = await doc.embedFont(family.bold);

  for (const layout of pages) {
    const page = doc.addPage([layout.widthPt, layout.heightPt]);

    // Table borders first so text draws on top of them.
    for (const table of layout.tables) {
      const [x0, yTop, x1, yBottom] = table.bboxPt;
      page.drawRectangle({
        x: x0,
        y: layout.heightPt - yBottom,
        width: x1 - x0,
        height: yBottom - yTop,
        borderColor: rgb(0.3, 0.3, 0.3),
        borderWidth: 0.7,
      });
    }

    for (const op of layout.ops) {
      // StandardFonts are WinAnsi (Latin-1): German umlauts/ß are fine, but a
      // character outside that range throws here — by design, since a fixture
      // silently mojibake-ing its own input would defeat the point of it.
      page.drawText(op.text, {
        x: op.x,
        y: layout.heightPt - op.yTop,
        size: op.size,
        font: op.bold ? bold : font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
  }

  return doc.save();
}
