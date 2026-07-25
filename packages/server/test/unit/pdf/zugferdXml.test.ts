import { AFRelationship, PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { loadGolden, serializeCiiFromCanonical } from "@invex/fixtures";
import { extractZugferdXml } from "../../../src/pdf/zugferdXml";

// Real CII XML, independently authored (not derived from the parser it will
// later feed) — see de-standard-19's `expected.canonical`.
const canonical = loadGolden("de-standard-19").expected.canonical!;
const CII_XML = serializeCiiFromCanonical(canonical);

async function pdfWithAttachments(
  attachments: Array<{ name: string; bytes: Uint8Array; mimeType?: string }>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  for (const a of attachments) {
    await doc.attach(a.bytes, a.name, {
      mimeType: a.mimeType ?? "text/xml",
      afRelationship: AFRelationship.Alternative,
    });
  }
  return doc.save();
}

describe("extractZugferdXml", () => {
  it("extracts the embedded CII XML byte-exact from a hybrid PDF", async () => {
    const pdf = await pdfWithAttachments([{ name: "factur-x.xml", bytes: new TextEncoder().encode(CII_XML) }]);

    const result = await extractZugferdXml(pdf);

    expect(result?.filename).toBe("factur-x.xml");
    expect(result?.xml).toBe(CII_XML);
  });

  it("returns null when the PDF has no attachments at all", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const pdf = await doc.save();

    expect(await extractZugferdXml(pdf)).toBeNull();
  });

  it("returns null when attachments exist but none match a zugferd name", async () => {
    const pdf = await pdfWithAttachments([
      { name: "terms.xml", bytes: new TextEncoder().encode("<terms/>") },
      { name: "logo.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" },
    ]);

    expect(await extractZugferdXml(pdf)).toBeNull();
  });

  it("strips a leading UTF-8 BOM from the extracted XML", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = new TextEncoder().encode(CII_XML);
    const withBom = new Uint8Array(bom.length + body.length);
    withBom.set(bom, 0);
    withBom.set(body, bom.length);
    const pdf = await pdfWithAttachments([{ name: "factur-x.xml", bytes: withBom }]);

    const result = await extractZugferdXml(pdf);

    expect(result?.xml).toBe(CII_XML);
    expect(result?.xml.startsWith("﻿")).toBe(false);
  });

  it("still returns bytes decoded as text when the attachment content is not XML at all", async () => {
    // Real world: a malformed/truncated companion file named like a ZUGfERD
    // attachment but containing garbage. extractZugferdXml does not validate
    // XML shape — it just decodes bytes — so the caller's XML parser is the
    // one that must reject this, not this function.
    const garbage = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x10, 0x20]);
    const pdf = await pdfWithAttachments([{ name: "factur-x.xml", bytes: garbage }]);

    const result = await extractZugferdXml(pdf);

    expect(result).not.toBeNull();
    expect(result?.filename).toBe("factur-x.xml");
    expect(typeof result?.xml).toBe("string");
  });

  it("picks the one matching attachment out of several, regardless of attachment order", async () => {
    const pdf = await pdfWithAttachments([
      { name: "terms.xml", bytes: new TextEncoder().encode("<terms/>") },
      { name: "logo.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" },
      { name: "factur-x.xml", bytes: new TextEncoder().encode(CII_XML) },
    ]);

    const result = await extractZugferdXml(pdf);

    expect(result?.filename).toBe("factur-x.xml");
    expect(result?.xml).toBe(CII_XML);
  });

  it("also recognizes the zugferd-invoice.xml and xrechnung.xml names", async () => {
    for (const name of ["zugferd-invoice.xml", "xrechnung.xml"]) {
      const pdf = await pdfWithAttachments([{ name, bytes: new TextEncoder().encode(CII_XML) }]);
      const result = await extractZugferdXml(pdf);
      expect(result?.filename).toBe(name);
      expect(result?.xml).toBe(CII_XML);
    }
  });
});
