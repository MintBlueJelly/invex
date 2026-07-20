import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { LaneRoute } from "../db/schema";

/**
 * Ingest triage (briefing §2): embedded ZUGfERD/Factur-X XML → Path A; else
 * selectable-character count over the first N pages decides text vs image.
 * The text-quality gate re-checks INSIDE the text lane and may still reroute.
 */

export interface TriageOptions {
  pagesToScan: number;
  textCharThreshold: number;
}

export interface TriageOutcome {
  route: LaneRoute;
  /** Written verbatim into the `routed` trace event — the "why". */
  reason: Record<string, unknown>;
  embeddedXml: Uint8Array | null;
  xmlFilename: string | null;
  pageCount: number;
}

const ZUGFERD_NAME_PATTERNS = [
  /^zugferd-invoice\.xml$/i,
  /^factur-x\.xml$/i,
  /^xrechnung\.xml$/i,
  /factur/i,
  /zugferd/i,
];

export function isZugferdAttachmentName(name: string): boolean {
  return ZUGFERD_NAME_PATTERNS.some((p) => p.test(name));
}

export async function triagePdf(pdf: Uint8Array, opts: TriageOptions): Promise<TriageOutcome> {
  // pdf.js may transfer/detach the buffer it is given — always hand it a copy.
  const task = getDocument({ data: new Uint8Array(pdf) });
  const doc = await task.promise;
  try {
    const pageCount = doc.numPages;

    // pdf.js v6: getAttachments() returns a Map of metadata; content is lazy.
    const attachments = await doc.getAttachments();
    if (attachments) {
      for (const [key, att] of attachments.entries()) {
        const name = att.filename || key;
        if (isZugferdAttachmentName(name)) {
          return {
            route: "zugferd",
            reason: { xmlAttachment: name },
            embeddedXml: null, // the zugferd stage re-extracts stateless
            xmlFilename: name,
            pageCount,
          };
        }
      }
    }

    let chars = 0;
    const pages = Math.min(pageCount, opts.pagesToScan);
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      for (const item of tc.items) {
        if ("str" in item) chars += item.str.replace(/\s/g, "").length;
      }
      if (chars > opts.textCharThreshold) break;
    }

    const route: LaneRoute = chars > opts.textCharThreshold ? "text" : "image";
    return {
      route,
      reason: { charCount: chars, threshold: opts.textCharThreshold, pagesScanned: pages },
      embeddedXml: null,
      xmlFilename: null,
      pageCount,
    };
  } finally {
    await task.destroy();
  }
}
