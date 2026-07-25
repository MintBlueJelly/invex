import { AFRelationship, PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { goldenPdf, loadGolden } from "@invex/fixtures";
import { isZugferdAttachmentName, triagePdf } from "../../../src/pdf/triage";
import { knownBug } from "../../../../../test-utils/knownBug";

/**
 * Matches config/pipeline.json's `triage` block. Declared inline per the
 * assignment rather than read from disk, so this suite pins the two numbers
 * that actually govern production routing.
 */
const TRIAGE = { pagesToScan: 3, textCharThreshold: 50 };

/**
 * A page with exactly `n` non-whitespace characters, as a single drawText
 * call. pdf.js's text-content items line up 1:1 with drawText calls for a
 * short single-line string, so `n` survives untouched through the
 * `.replace(/\s/g, "").length` the triage code applies.
 */
async function pdfWithPerPageChars(pagesChars: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const n of pagesChars) {
    const page = doc.addPage([595, 842]);
    if (n > 0) page.drawText("x".repeat(n), { x: 50, y: 800, size: 8, font });
  }
  return doc.save();
}

async function pdfWithAttachment(name: string, opts?: { pageChars?: number }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  if (opts?.pageChars) page.drawText("x".repeat(opts.pageChars), { x: 50, y: 800, size: 8, font });
  await doc.attach(new TextEncoder().encode("<xml/>"), name, {
    mimeType: "text/xml",
    afRelationship: AFRelationship.Alternative,
  });
  return doc.save();
}

describe("triagePdf", () => {
  it("routes a born-digital text-layer invoice to the text lane, with the count and threshold in the reason", async () => {
    // Realistic email attachment: a real invoice layout, not synthetic filler text.
    const pdf = await goldenPdf(loadGolden("de-standard-19"));
    const outcome = await triagePdf(pdf, TRIAGE);

    expect(outcome.route).toBe("text");
    expect(outcome.reason["threshold"]).toBe(50);
    expect(typeof outcome.reason["charCount"]).toBe("number");
    expect(outcome.reason["charCount"] as number).toBeGreaterThan(50);
  });

  it("routes a textless (scanned-image-shaped) PDF to the image lane", async () => {
    const pdf = await pdfWithPerPageChars([0]);
    const outcome = await triagePdf(pdf, TRIAGE);

    expect(outcome.route).toBe("image");
    expect(outcome.reason).toEqual({ charCount: 0, threshold: 50, pagesScanned: 1 });
  });

  it("textCharThreshold boundary: one char under the threshold stays on the image lane", async () => {
    const pdf = await pdfWithPerPageChars([49]);
    const outcome = await triagePdf(pdf, TRIAGE);

    expect(outcome.route).toBe("image");
    expect(outcome.reason["charCount"]).toBe(49);
  });

  it("textCharThreshold boundary: exactly the threshold is NOT enough (strict >, not >=)", async () => {
    const pdf = await pdfWithPerPageChars([50]);
    const outcome = await triagePdf(pdf, TRIAGE);

    expect(outcome.route).toBe("image");
    expect(outcome.reason["charCount"]).toBe(50);
  });

  it("textCharThreshold boundary: one char over the threshold crosses to the text lane", async () => {
    const pdf = await pdfWithPerPageChars([51]);
    const outcome = await triagePdf(pdf, TRIAGE);

    expect(outcome.route).toBe("text");
    expect(outcome.reason["charCount"]).toBe(51);
  });

  it("pagesToScan stops scanning after the configured page count, even if later pages have text", async () => {
    // A real-world case: a cover sheet / blank fax-header pages followed by the
    // actual invoice content on page 4 — triage must not "get lucky" past its budget.
    const pdf = await pdfWithPerPageChars([0, 0, 0, 500]);
    const outcome = await triagePdf(pdf, TRIAGE);

    expect(outcome.route).toBe("image");
    expect(outcome.reason).toEqual({ charCount: 0, threshold: 50, pagesScanned: 3 });
    // pageCount reflects the whole document, independent of how much was scanned.
    expect(outcome.pageCount).toBe(4);
  });

  it("breaks the scan loop early once the threshold is crossed, but reason.pagesScanned still reports the full budget", async () => {
    // `pagesScanned` is `Math.min(pageCount, pagesToScan)` computed up front, not
    // a count of loop iterations actually executed — so it stays 3 here even
    // though the loop body only ran once before `break`. Worth knowing before
    // using this field to reason about scan cost.
    const pdf = await pdfWithPerPageChars([100, 0, 0]);
    const outcome = await triagePdf(pdf, TRIAGE);

    expect(outcome.route).toBe("text");
    expect(outcome.reason).toEqual({ charCount: 100, threshold: 50, pagesScanned: 3 });
  });

  describe("zugferd route via embedded attachment", () => {
    it.each(["factur-x.xml", "zugferd-invoice.xml", "xrechnung.xml"])(
      "routes to zugferd when the attachment is named %s",
      async (name) => {
        const pdf = await pdfWithAttachment(name);
        const outcome = await triagePdf(pdf, TRIAGE);

        expect(outcome.route).toBe("zugferd");
        expect(outcome.xmlFilename).toBe(name);
        expect(outcome.reason).toEqual({ xmlAttachment: name });
        // embeddedXml is never populated by triage itself — the zugferd stage
        // re-extracts statelessly (see the comment in triage.ts). Every
        // TriageOutcome, on every route, carries embeddedXml: null.
        expect(outcome.embeddedXml).toBeNull();
      },
    );

    it("an unrelated attachment name does not force the zugferd route — the document is still triaged on its text", async () => {
      // terms.xml / logo.png: real-world companion attachments (T&Cs, a letterhead
      // logo) that must not derail routing just because *some* XML/asset is attached.
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([595, 842]);
      page.drawText("x".repeat(100), { x: 50, y: 800, size: 8, font });
      await doc.attach(new TextEncoder().encode("<terms/>"), "terms.xml", { mimeType: "text/xml" });
      await doc.attach(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "logo.png", { mimeType: "image/png" });
      const pdf = await doc.save();

      const outcome = await triagePdf(pdf, TRIAGE);

      expect(outcome.route).toBe("text");
    });
  });

  describe("INVEX-052 — unanchored factur/zugferd patterns misroute unrelated attachments", () => {
    it("[current] an attachment merely named with \"zugferd\" in it sends the whole document down Path A", async () => {
      // A vendor emails an invoice plus a scratch file that happens to be named
      // this way; nothing about it is a ZUGfERD/Factur-X payload.
      const pdf = await pdfWithAttachment("my-zugferd-notes.txt", { pageChars: 200 });
      const outcome = await triagePdf(pdf, TRIAGE);

      expect(outcome.route).toBe("zugferd");
    });

    knownBug("INVEX-052", "unanchored /factur/i and /zugferd/i misroute unrelated attachments to Path A").it(
      "a companion attachment that merely contains \"zugferd\" in its name must not preempt text/image triage",
      async () => {
        const pdf = await pdfWithAttachment("my-zugferd-notes.txt", { pageChars: 200 });
        const outcome = await triagePdf(pdf, TRIAGE);

        expect(outcome.route).toBe("text");
      },
    );
  });

  describe("structurally degenerate documents", () => {
    it("a PDF with no pages added still yields a triage outcome (pdf.js recovers a single implicit page)", async () => {
      // pdf-lib happily saves a 0-page document; pdf.js, asked to open it,
      // reports numPages === 1 rather than 0 — a recovery quirk worth pinning
      // down so a future pdf.js bump that changes this doesn't go unnoticed.
      const doc = await PDFDocument.create();
      const pdf = await doc.save();

      const outcome = await triagePdf(pdf, TRIAGE);

      expect(outcome.pageCount).toBe(1);
      expect(outcome.route).toBe("image");
      expect(outcome.reason).toEqual({ charCount: 0, threshold: 50, pagesScanned: 1 });
    });

    it("rejects a corrupt/truncated byte stream instead of silently misrouting it", async () => {
      // The real-world equivalent: a half-downloaded email attachment or a
      // non-PDF byte blob wrongly tagged application/pdf.
      const garbage = new Uint8Array([1, 2, 3, 4, 5]);

      await expect(triagePdf(garbage, TRIAGE)).rejects.toThrow(/invalid pdf structure/i);
    });
  });
});

describe("isZugferdAttachmentName", () => {
  it.each(["zugferd-invoice.xml", "factur-x.xml", "xrechnung.xml"])("matches the exact canonical name %s", (name) => {
    expect(isZugferdAttachmentName(name)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isZugferdAttachmentName("ZUGFERD-INVOICE.XML")).toBe(true);
    expect(isZugferdAttachmentName("Factur-X.xml")).toBe(true);
    expect(isZugferdAttachmentName("XRechnung.XML")).toBe(true);
  });

  it("does not match an unrelated attachment name", () => {
    expect(isZugferdAttachmentName("terms.xml")).toBe(false);
    expect(isZugferdAttachmentName("logo.png")).toBe(false);
  });

  describe("INVEX-052 — trailing unanchored patterns", () => {
    it.each(["my-zugferd-notes.txt", "factura.doc", "refactured.xml"])(
      "[current] %s is (wrongly) treated as a zugferd attachment name",
      (name) => {
        expect(isZugferdAttachmentName(name)).toBe(true);
      },
    );

    for (const name of ["my-zugferd-notes.txt", "factura.doc", "refactured.xml"]) {
      knownBug("INVEX-052", "substring match on /factur/i or /zugferd/i, not an actual attachment name").it(
        `${name} should not be treated as a zugferd attachment name`,
        () => {
          expect(isZugferdAttachmentName(name)).toBe(false);
        },
      );
    }
  });
});
