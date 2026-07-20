import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { isZugferdAttachmentName } from "./triage";

/** Re-extract the embedded ZUGfERD/Factur-X XML from a hybrid PDF. */
export async function extractZugferdXml(
  pdf: Uint8Array,
): Promise<{ filename: string; xml: string } | null> {
  const task = getDocument({ data: new Uint8Array(pdf) });
  const doc = await task.promise;
  try {
    // pdf.js v6: metadata via getAttachments(), bytes via getAttachmentContent(key).
    const attachments = await doc.getAttachments();
    if (!attachments) return null;
    for (const [key, att] of attachments.entries()) {
      const name = att.filename || key;
      if (!isZugferdAttachmentName(name)) continue;
      const content = att.content ?? (await doc.getAttachmentContent(key));
      if (!content) continue;
      // Strip a potential BOM; CII is spec'd as UTF-8.
      const xml = new TextDecoder("utf-8").decode(content).replace(/^﻿/, "");
      return { filename: name, xml };
    }
    return null;
  } finally {
    await task.destroy();
  }
}
