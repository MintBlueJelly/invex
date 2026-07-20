import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

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
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // @napi-rs/canvas is API-compatible with the DOM canvas pdf.js expects;
      // the server tsconfig has no DOM lib, hence the cast.
      await page.render({ canvas, canvasContext: ctx, viewport } as unknown as Parameters<
        typeof page.render
      >[0]).promise;
      out.push(new Uint8Array(canvas.toBuffer("image/png")));
    }
    return out;
  } finally {
    await task.destroy();
  }
}
