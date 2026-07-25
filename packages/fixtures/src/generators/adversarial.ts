import { AFRelationship, PDFDocument } from "pdf-lib";
import { serializeCii } from "../ciiXml";
import { sampleSpec } from "../spec";

/**
 * The adversarial corpus: bytes an n8n mailbox poller will eventually forward
 * to `POST /api/ingest` without any human looking at them first — truncated
 * downloads, mislabelled attachments, hostile XML, a PDF that only LOOKS like
 * one. DEPLOYMENT.md's poison-document failure mode exists because a single
 * bad document can wedge the only replica forever; every generator here is
 * something that must NOT do that, whatever else it does.
 *
 * Nothing here uses Math.random() — every byte is deterministic so a failing
 * test points at the same input on every re-run.
 */

const enc = new TextEncoder();

// ── malformed / absent PDF structure ────────────────────────────────────────

/** The email attachment that never arrived: 0 bytes. Ingest must not store it. */
export function makeZeroBytePdf(): Uint8Array {
  return new Uint8Array(0);
}

/** A connection that died after the magic bytes — no body, no xref, no EOF. */
export function makeHeaderOnlyPdf(): Uint8Array {
  return enc.encode("%PDF-1.7\n");
}

/**
 * A download that stopped partway: valid header, but the xref/trailer this
 * PDF needs are past the cut. `source` is caller-supplied (e.g. a real golden
 * PDF) so the truncation lands inside genuine content, not an empty shell.
 */
export function makeTruncatedPdf(source: Uint8Array, keepFraction = 0.4): Uint8Array {
  return source.slice(0, Math.floor(source.length * keepFraction));
}

/** Bytes that are some other file format entirely, wearing a .pdf name. */
export function makeNotAPdf(kind: "png" | "zip" | "html" | "text"): Uint8Array {
  switch (kind) {
    case "png":
      // PNG signature + a fake IHDR chunk — enough to look real to a byte-sniffer.
      return new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x02, 0x00, 0x00, 0x00,
      ]);
    case "zip":
      // Local file header signature "PK\x03\x04" + arbitrary junk.
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    case "html":
      return enc.encode("<!DOCTYPE html><html><body>Not a PDF, an inbox reply.</body></html>");
    case "text":
      return enc.encode("Dear Sir or Madam, please find the invoice below.\n(There is no invoice below.)\n");
  }
}

// ── PDFs that are structurally valid but pathological ───────────────────────

/**
 * A page whose declared MediaBox asks for a rasterization far beyond what any
 * real invoice needs. The PDF itself stays tiny — a blank page has no content
 * stream to speak of — only the DECLARED dimensions are huge. Do not raise
 * these defaults: `packages/server/src/pdf/rasterize.ts`'s MAX_RASTER_PIXELS
 * guard is sized against exactly this 14400x14400 case (INVEX-006), and
 * `packages/server/test/unit/pdf/rasterize.test.ts` pins the unit-level
 * rejection — the ingest-level test here only needs the guard to have fired,
 * never to allocate the canvas itself.
 */
export async function makeHugeMediaBoxPdf(widthPt = 14_400, heightPt = 14_400): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([widthPt, heightPt]);
  return doc.save();
}

/** Many blank pages — cheap to generate, but exercises page-count handling in triage/rasterization. */
export async function makeManyPagesPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([100, 100]);
  return doc.save();
}

// ── hostile embedded ZUGfERD/Factur-X XML ───────────────────────────────────

function xmlBombPayload(kind: "billion-laughs" | "deep-nesting" | "external-entity"): string {
  switch (kind) {
    case "billion-laughs":
      // The textbook exponential-entity-expansion payload. fast-xml-parser's
      // DocTypeReader (verified by reading its source) drops any <!ENTITY>
      // whose value contains "&" before registering it, so lol1..lol9 here
      // never make it into the entity table and &lol9; cannot expand — but the
      // point of the fixture is to prove that end to end, not to trust the
      // source reading.
      return (
        '<?xml version="1.0"?>\n' +
        "<!DOCTYPE lolz [\n" +
        ' <!ENTITY lol "lol">\n' +
        ' <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">\n' +
        ' <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">\n' +
        ' <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">\n' +
        ' <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">\n' +
        ' <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">\n' +
        ' <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">\n' +
        ' <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">\n' +
        ' <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">\n' +
        ' <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">\n' +
        "]>\n" +
        "<CrossIndustryInvoice><ram:Note>&lol9;</ram:Note></CrossIndustryInvoice>\n"
      );
    case "deep-nesting": {
      // 2000 levels: deep enough to matter for a recursive-descent parser or
      // JSON.stringify(), shallow enough that even a real stack overflow is an
      // ordinary catchable RangeError inside parseCiiToEnvelope's synchronous
      // call — never a process crash. Not the CII root, so parsing either
      // throws on the depth or (harmlessly) on the missing root afterward.
      const N = 2000;
      return '<?xml version="1.0"?>\n' + "<a>".repeat(N) + "x" + "</a>".repeat(N);
    }
    case "external-entity":
      // Classic XXE. fast-xml-parser's DocTypeReader has no network access at
      // all — SYSTEM entities are text substitution against a literal string,
      // never a fetch — so this can prove local-file/URL disclosure, only a
      // parse outcome (accepted-as-literal vs rejected).
      return (
        '<?xml version="1.0"?>\n' +
        "<!DOCTYPE foo [\n" +
        ' <!ENTITY xxe SYSTEM "file:///etc/passwd">\n' +
        "]>\n" +
        "<CrossIndustryInvoice><ram:Note>&xxe;</ram:Note></CrossIndustryInvoice>\n"
      );
  }
}

/** A "factur-x.xml" attachment carrying a hostile XML payload instead of CII. */
export async function makeXmlBombZugferdPdf(
  kind: "billion-laughs" | "deep-nesting" | "external-entity",
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  const xml = enc.encode(xmlBombPayload(kind));
  await doc.attach(xml, "factur-x.xml", {
    mimeType: "text/xml",
    description: `adversarial: ${kind}`,
    afRelationship: AFRelationship.Alternative,
  });
  return doc.save();
}

/** A "factur-x.xml" name whose bytes are actually a PNG — the name lies about the content. */
export async function makeWrongTypeAttachmentPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  const png = makeNotAPdf("png");
  await doc.attach(png, "factur-x.xml", {
    mimeType: "text/xml",
    description: "adversarial: wrong-type attachment",
    afRelationship: AFRelationship.Alternative,
  });
  return doc.save();
}

/** Two attachments that both look like ZUGfERD XML, disagreeing on the invoice. */
export async function makeMultiXmlAttachmentPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  const first = serializeCii(sampleSpec());
  const second = serializeCii(sampleSpec({ invoiceNumber: "RIVAL-999" }));
  // Attachment order is insertion order; triage and the zugferd stage both
  // scan attachments the same way, so whichever is attached FIRST is what a
  // real ingest would silently commit — worth proving stays consistent
  // between triage's decision and the stage's own re-extraction.
  await doc.attach(enc.encode(first), "factur-x.xml", {
    mimeType: "text/xml",
    description: "adversarial: rival attachment A",
    afRelationship: AFRelationship.Alternative,
  });
  await doc.attach(enc.encode(second), "zugferd-invoice.xml", {
    mimeType: "text/xml",
    description: "adversarial: rival attachment B",
    afRelationship: AFRelationship.Alternative,
  });
  return doc.save();
}

// ── filenames ────────────────────────────────────────────────────────────────

/**
 * Filenames real mail clients and forwarding chains actually produce (or that
 * a hostile sender crafts on purpose) — never bytes-level content, purely the
 * multipart filename= value the ingest route stores verbatim.
 */
export function adversarialFilenames(): string[] {
  return [
    "Rechnung_Übersicht_日本語_😀_#7.pdf",
    "../../../etc/passwd.pdf",
    "..\\..\\windows\\system32\\evil.pdf",
    // NUL-byte extension bypass: naive filters that check the tail after the
    // last "." see ".exe", but a C string / filesystem call would stop at \0.
    "invoice .pdf.exe",
    "a".repeat(4096) + ".pdf",
    "",
  ];
}
