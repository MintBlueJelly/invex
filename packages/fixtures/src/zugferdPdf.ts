import { PDFDocument, AFRelationship } from "pdf-lib";
import { serializeCii } from "./ciiXml";
import { makeTextInvoicePdf } from "./textPdf";
import type { InvoiceSpec } from "./spec";

/** Hybrid ZUGfERD/Factur-X PDF: visual invoice + embedded CII XML (Path A). */
export async function makeZugferdPdf(spec: InvoiceSpec): Promise<Uint8Array> {
  const base = await makeTextInvoicePdf(spec);
  const doc = await PDFDocument.load(base);
  const xml = new TextEncoder().encode(serializeCii(spec));
  await doc.attach(xml, "factur-x.xml", {
    mimeType: "text/xml",
    description: "Factur-X invoice data",
    afRelationship: AFRelationship.Alternative,
  });
  return doc.save();
}

/**
 * ZUGfERD PDF whose embedded XML is truncated mid-element — Path A must fall
 * through to the text lane gracefully, never hard-error (briefing §2).
 */
export async function makeMalformedZugferdPdf(spec: InvoiceSpec): Promise<Uint8Array> {
  const base = await makeTextInvoicePdf(spec);
  const doc = await PDFDocument.load(base);
  const xml = serializeCii(spec);
  const truncated = xml.slice(0, Math.floor(xml.length * 0.4)) + "<ram:Broken";
  await doc.attach(new TextEncoder().encode(truncated), "factur-x.xml", {
    mimeType: "text/xml",
    description: "broken",
    afRelationship: AFRelationship.Alternative,
  });
  return doc.save();
}
