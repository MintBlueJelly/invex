import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { MAX_RASTER_PIXELS, rasterizePdf } from "../../../src/pdf/rasterize";

/**
 * INVEX-006 — the rasterizer had no page-dimension guard.
 *
 * This is the concrete mechanism behind the poison document docs/deployment.md
 * describes. A PDF declaring a huge MediaBox asks for a canvas of
 * width x height x dpi/72 pixels; at the configured 150 dpi a 200x200 inch page
 * is ~30000x30000 = 900 megapixels, i.e. ~3.6 GB of RGBA. The process is
 * OOM-killed, which rolls the claim transaction back WITHOUT incrementing
 * attempts — so the same document is re-claimed first on every restart (claims
 * are oldest-first) and blocks everything behind it forever.
 *
 * The guard must reject before allocating. A test that actually attempted the
 * allocation would take the CI runner down with it.
 */

async function pdfWithPageSize(widthPt: number, heightPt: number, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([widthPt, heightPt]);
  return doc.save();
}

const A4 = { w: 595.276, h: 841.89 };

describe("rasterizePdf", () => {
  it("rasterizes an ordinary A4 page", async () => {
    const pdf = await pdfWithPageSize(A4.w, A4.h);
    const pages = await rasterizePdf(pdf, { dpi: 150, maxPages: 5 });

    expect(pages).toHaveLength(1);
    // PNG magic bytes.
    expect(Array.from(pages[0]!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("respects maxPages", async () => {
    const pdf = await pdfWithPageSize(A4.w, A4.h, 4);
    expect(await rasterizePdf(pdf, { dpi: 72, maxPages: 2 })).toHaveLength(2);
  });

  it("rejects a page whose raster would exceed the pixel budget, without allocating", async () => {
    // 200x200 inch = 14400pt. At 150 dpi that is ~30000x30000 = 900 MP.
    const pdf = await pdfWithPageSize(14_400, 14_400);
    await expect(rasterizePdf(pdf, { dpi: 150, maxPages: 1 })).rejects.toThrow(/too large|pixel budget/i);
  });

  it("names the page and the numbers in the error, so the poison document is identifiable", async () => {
    const pdf = await pdfWithPageSize(14_400, 14_400);
    await expect(rasterizePdf(pdf, { dpi: 150, maxPages: 1 })).rejects.toThrow(/page 1/i);
  });

  it("still accepts a large-but-sane page at a reduced dpi", async () => {
    // A0 at 72 dpi is ~2384x3370 = 8 MP — big, but nothing like a runaway.
    const pdf = await pdfWithPageSize(2384, 3370);
    const pages = await rasterizePdf(pdf, { dpi: 72, maxPages: 1 });
    expect(pages).toHaveLength(1);
  });

  it("exposes a budget that is generous for real paper but bounded", async () => {
    const a4At150 = Math.ceil((A4.w * 150) / 72) * Math.ceil((A4.h * 150) / 72);
    expect(MAX_RASTER_PIXELS).toBeGreaterThan(a4At150 * 4);
    // Bounded well below the ~900 MP a runaway MediaBox asks for.
    expect(MAX_RASTER_PIXELS).toBeLessThan(100_000_000);
  });
});
