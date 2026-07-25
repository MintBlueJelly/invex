import { isSynthetic, layoutInvoice, loadGolden, renderPdf } from "@invex/fixtures";
import { withInvoiceNumber } from "./literalVariants";

/**
 * A real, unique, born-digital PDF derived from de-standard-19's own layout —
 * only the printed invoice number changes. In every test that uses this, the
 * pipeline's docling response is faked separately (FakeDocling), so this PDF's
 * only jobs are (a) routing to the text lane (real extractable text, well
 * above the char threshold) and (b) giving ingest a fresh content hash per
 * call. Its printed fields are never read as ground truth.
 */
const golden = loadGolden("de-standard-19");
if (!isSynthetic(golden)) throw new Error("de-standard-19 golden must be synthetic");
const baseDoc = golden.render.doc;

export function uniqueTextPdf(invoiceNumber: string): Promise<Uint8Array> {
  return renderPdf(layoutInvoice(withInvoiceNumber(baseDoc, invoiceNumber)));
}
