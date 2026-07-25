import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Per-page raster budget, in pixels.
 *
 * A page's canvas is width x height x (dpi/72) pixels at 4 bytes each, and the
 * PDF declares those dimensions. A MediaBox of 200x200 inches at the configured
 * 150 dpi asks for ~30000x30000 = 900 MP, i.e. ~3.6 GB of RGBA — the container
 * is OOM-killed before the allocation returns.
 *
 * That is not merely a failed document. The kill rolls the claim transaction
 * back WITHOUT incrementing `attempts`, and claims are ordered oldest-first, so
 * the same document is re-claimed immediately on every restart and blocks the
 * whole queue — the poison document in DEPLOYMENT.md's troubleshooting section.
 * With one replica on a Recreate strategy there is nothing else to pick up the
 * work (INVEX-006).
 *
 * 25 MP is ~11x an A4 page at 150 dpi (2.2 MP) and covers A1 at 150 dpi, so it
 * accepts any realistic invoice — including large scanned plans — while
 * bounding a single page to ~100 MB of canvas.
 */
export const MAX_RASTER_PIXELS = 25_000_000;

/** Rasterize PDF pages to PNG buffers for the VLM (briefing §2 step 6). */
export async function rasterizePdf(
  pdf: Uint8Array,
  opts: { dpi: number; maxPages: number; pages?: number[] },
): Promise<Uint8Array[]> {
  const task = getDocument({ data: new Uint8Array(pdf) });
  const doc = await task.promise;
  try {
    const wanted = (opts.pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1))
      .filter((p) => p >= 1 && p <= doc.numPages)
      .slice(0, opts.maxPages);
    const scale = opts.dpi / 72;
    const out: Uint8Array[] = [];
    for (const pageNo of wanted) {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);

      // Check BEFORE allocating: the whole point is that the allocation itself
      // is what kills the process, and a dead process cannot record the failure.
      // Throwing makes this an ordinary stage error, so the document takes the
      // normal attempts path to `failed` instead of wedging the queue.
      if (width * height > MAX_RASTER_PIXELS) {
        throw new Error(
          `page ${pageNo} is too large to rasterize: ${width}x${height} = ` +
            `${Math.round((width * height) / 1e6)} MP at ${opts.dpi} dpi exceeds the ` +
            `${Math.round(MAX_RASTER_PIXELS / 1e6)} MP pixel budget`,
        );
      }

      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // @napi-rs/canvas is API-compatible with the DOM canvas pdf.js expects;
      // the server tsconfig has no DOM lib, hence the cast.
      await page.render({ canvas, canvasContext: ctx, viewport } as unknown as Parameters<
        typeof page.render
      >[0]).promise;
      out.push(new Uint8Array(canvas.toBuffer("image/png")));
      // Release the page's operator list and font data now rather than at
      // task.destroy(): with maxPages: 5 at 150 dpi the peak otherwise carries
      // every page's intermediate state at once, alongside the PNG buffers and
      // docling's base64 copy of the same PDF.
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}
