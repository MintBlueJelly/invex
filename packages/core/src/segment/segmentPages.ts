import { normalizeLabel, type PositionedTextDocument } from "../positioned/model";

/**
 * Page-level segmentation BEFORE classification (briefing §2 Path B step 2):
 * multi-invoice PDFs and attachment pages (terms behind the invoice) must not
 * bleed into each other's table extraction. Deliberately CONSERVATIVE — only
 * strong signals split; the default is one segment.
 */

export interface Segment {
  /** 1-based page numbers, ascending. */
  pages: number[];
  kind: "invoice-candidate" | "attachment";
}

const ATTACHMENT_HEADINGS = [
  /allgemeine\s+gesch[aä]ftsbedingungen/i,
  /\bAGB\b/,
  /terms\s+(and|&)\s+conditions/i,
  /widerrufsbelehrung/i,
];

const PAGE_COUNTER = /seite\s+(\d+)\s+von\s+(\d+)|page\s+(\d+)\s+of\s+(\d+)/i;
const INVOICE_HEADING = /^(rechnung|invoice|gutschrift|credit\s?note)\b/i;
const TOTAL_LABELS = ["gesamtbetrag", "rechnungsbetrag", "endbetrag", "total", "zuzahlen", "zahlbetrag"];

interface PageInfo {
  page: number;
  isAttachmentStart: boolean;
  counterRestart: boolean;
  invoiceHeading: boolean;
  hasTotalBlock: boolean;
}

export function segmentPages(doc: PositionedTextDocument): Segment[] {
  const infos: PageInfo[] = [];
  for (let p = 1; p <= doc.pageCount; p++) {
    const lines = doc.lines.filter((l) => l.page === p);
    const topLines = lines.filter((l) => l.bbox[1] < 0.3);
    const text = lines.map((l) => l.text).join("\n");

    let counterRestart = false;
    const m = PAGE_COUNTER.exec(text);
    if (m && p > 1) {
      const current = Number(m[1] ?? m[3]);
      if (current === 1) counterRestart = true;
    }

    infos.push({
      page: p,
      isAttachmentStart: topLines.some((l) => ATTACHMENT_HEADINGS.some((rx) => rx.test(l.text))),
      counterRestart,
      invoiceHeading: topLines.some(
        (l) => INVOICE_HEADING.test(l.text.trim()) || (l.tag === "section_header" && INVOICE_HEADING.test(l.text.trim())),
      ),
      hasTotalBlock: lines.some((l) => {
        const norm = normalizeLabel(l.text);
        return TOTAL_LABELS.some((t) => norm.includes(t)) && /\d/.test(l.text);
      }),
    });
  }

  const segments: Segment[] = [];
  let current: Segment | null = null;
  let currentSawTotal = false;

  for (const info of infos) {
    const startsAttachment = info.isAttachmentStart;
    const startsNewInvoice =
      current !== null &&
      current.kind === "invoice-candidate" &&
      !startsAttachment &&
      (info.counterRestart || (info.invoiceHeading && currentSawTotal));

    if (current === null || startsAttachment !== (current.kind === "attachment") || startsNewInvoice) {
      current = { pages: [], kind: startsAttachment ? "attachment" : "invoice-candidate" };
      segments.push(current);
      currentSawTotal = false;
    }
    current.pages.push(info.page);
    if (info.hasTotalBlock) currentSawTotal = true;
  }

  return segments.length > 0 ? segments : [{ pages: [], kind: "invoice-candidate" }];
}

/** Restrict a positioned doc to a set of pages (renumbered 1..n). */
export function slicePages(doc: PositionedTextDocument, pages: number[]): PositionedTextDocument {
  const order = new Map(pages.map((p, i) => [p, i + 1]));
  return {
    pageCount: pages.length,
    lines: doc.lines
      .filter((l) => order.has(l.page))
      .map((l) => ({ ...l, page: order.get(l.page)!, tokens: l.tokens.map((t) => ({ ...t, page: order.get(t.page) ?? 1 })) })),
    tables: doc.tables.filter((t) => order.has(t.page)).map((t) => ({ ...t, page: order.get(t.page)! })),
    ...(doc.markdown !== undefined ? { markdown: doc.markdown } : {}),
  };
}
