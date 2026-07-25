import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import {
  goldenOcrDocling,
  isSynthetic,
  layoutInvoice,
  loadGolden,
  renderOcrDoclingJson,
  type LiteralInvoiceDoc,
  type PageLayout,
} from "@invex/fixtures";
import type { CanonicalInvoice, VendorTemplate } from "@invex/core";
import { eq } from "drizzle-orm";
import { vendorTemplates } from "../../src/db/schema";
import { upsertTemplate } from "../../src/db/repos/templates";
import { StubVlm } from "../../src/clients/vlm/stub";
import { createTestEnv, FakeDocling, multipartBody, type TestEnv } from "../utils/testEnv";
import { withInvoiceNumber } from "../utils/literalVariants";

/**
 * Path C (image/OCR lane) integration. de-standard-19 stands in for the
 * "known ACME vendor" scans; the "unknown vendor" cases have no golden
 * equivalent (goldens model realistic single-vendor invoices, not a second
 * throwaway vendor purely for template-induction testing) and are built
 * locally through the layout seam.
 */

const standard = loadGolden("de-standard-19");
if (!isSynthetic(standard)) throw new Error("de-standard-19 golden must be synthetic");
const standardDoc = standard.render.doc;
const wantStandard = standard.expected.canonical!;

/** Template for the known scanned vendor (as human review / VLM would have
 * induced it) — labels match de-standard-19's ACTUAL printed totals block. */
function acmeTemplate(): VendorTemplate {
  return {
    templateVersion: 1,
    vendorIds: { ustIdNr: "DE811907980", displayName: "ACME Bürotechnik GmbH" },
    locale: { decimal: ",", dateFormats: ["dd.MM.yyyy"] },
    fields: {
      invoiceNumber: { label: "Rechnungs-Nr.", valuePattern: "R-\\d+-\\d+" },
      issueDate: { label: "Rechnungsdatum", valuePattern: "\\d{2}\\.\\d{2}\\.\\d{4}" },
      "totals.net": { label: "Zwischensumme", valuePattern: "-?[\\d.,]+" },
      "totals.tax": { label: "MwSt. 19 %", valuePattern: "-?[\\d.,]+" },
      "totals.gross": { label: "Gesamtbetrag", valuePattern: "-?[\\d.,]+" },
    },
    lineItemTable: {
      headerSignature: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
      columns: { position: 0, description: 1, quantity: 2, unitPrice: 3, lineTotal: 4 },
      descriptionContinuation: "rowsWithoutPosNumber",
    },
  };
}

/** An unknown scanned vendor (checksum-valid ids, simple totals) — no golden
 * equivalent; this vendor only exists to exercise VLM-driven template
 * induction on OCR output, distinct from the ACME golden scenario. */
function unknownVendorDoc(): LiteralInvoiceDoc {
  return {
    locale: "de",
    seller: {
      nameText: "Muster Verlag GmbH",
      addressLines: ["10115 Berlin"],
      taxIdLine: "USt-IdNr.: DE136695976",
    },
    headingText: "Rechnung",
    // Rechnungsdatum listed first: layoutInvoice aligns the heading with the
    // FIRST header field on the same row, and OCR word-induction would then
    // merge "Rechnung" into whichever label sits there. Only issueDate (not
    // asserted below) absorbs that merge; invoiceNumber gets a clean row.
    headerFields: [
      { labelText: "Rechnungsdatum", valueText: "01.06.2026" },
      { labelText: "Rechnungs-Nr.", valueText: "RG-77" },
    ],
    tableHeaders: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
    tableColumns: ["position", "description", "quantity", "unitPrice", "lineTotal"],
    lines: [
      { posText: "1", descriptionText: "Beratung", quantityText: "1", unitPriceText: "100,00", lineTotalText: "100,00" },
    ],
    totalsBlock: [
      { labelText: "Zwischensumme (netto)", valueText: "100,00" },
      { labelText: "MwSt. 19%", valueText: "19,00" },
      { labelText: "Gesamtbetrag", valueText: "119,00", bold: true },
    ],
  };
}

function ocrUnknownVendorDoclingJson(): unknown {
  return renderOcrDoclingJson(layoutInvoice(unknownVendorDoc()));
}

function unknownVendorInvoice(): CanonicalInvoice {
  return {
    schemaVersion: 1,
    invoiceNumber: "RG-77",
    issueDate: "2026-06-01",
    dueDate: null,
    currency: "EUR",
    locale: "de-DE",
    seller: { name: "Muster Verlag GmbH", ustIdNr: "DE136695976", steuernummer: null, ibans: [], address: null },
    buyer: null,
    totals: { net: "100.00", tax: "19.00", gross: "119.00" },
    vatBreakdown: [{ rate: 19, net: "100.00", tax: "19.00" }],
    lineItems: [
      { position: 1, description: "Beratung", quantity: "1", unit: null, unitPrice: "100.00", taxRate: 19, lineTotal: "100.00" },
    ],
    paymentTerms: null,
  };
}

/**
 * Rasterizes a page of positioned ops to a full-page PNG embedded in a PDF —
 * zero extractable text, so triage genuinely routes it to `image` (see
 * src/pdf/triage.ts: routing is decided purely by pdf.js text-char count).
 * Mirrors fixtures' scannedPdf.ts, but draws from the shared PageLayout ops
 * instead of re-deriving the invoice from computeInvoice/sampleSpec.
 */
async function rasterizePageToPdf(page: PageLayout): Promise<Uint8Array> {
  const SCALE = 1240 / 595.276; // ~150dpi at A4 width, matches scannedPdf.ts
  const w = Math.round(page.widthPt * SCALE);
  const h = Math.round(page.heightPt * SCALE);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#1a1a1a";
  for (const op of page.ops) {
    ctx.font = `${op.bold ? "bold " : ""}${Math.round(op.size * SCALE)}px sans-serif`;
    ctx.fillText(op.text, op.x * SCALE, (op.yTop + op.size) * SCALE);
  }
  const png = canvas.toBuffer("image/png");
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([page.widthPt, page.heightPt]);
  const img = await doc.embedPng(png);
  pdfPage.drawImage(img, { x: 0, y: 0, width: page.widthPt, height: page.heightPt });
  return doc.save();
}

/** Content only needs to be unique per ingest (content-hash dedup) — the
 * pipeline's docling response is always faked separately, so what is actually
 * printed/rasterized here is never read as ground truth. */
async function uniqueScannedPdf(tag: string): Promise<Uint8Array> {
  const [page] = layoutInvoice(withInvoiceNumber(standardDoc, tag));
  return rasterizePageToPdf(page!);
}

describe("Path C — image lane (VLM enabled)", () => {
  let env: TestEnv;
  let docling: FakeDocling;
  let vlm: StubVlm;

  beforeAll(async () => {
    docling = new FakeDocling();
    vlm = new StubVlm();
    env = await createTestEnv({
      docling,
      vlm,
      config: (cfg) => {
        cfg.pipeline.vlm.enabled = true;
      },
    });
  });

  afterAll(async () => {
    await env.close();
  });

  async function ingestScan(tag: string): Promise<string> {
    const pdf = await uniqueScannedPdf(tag);
    const { payload, headers } = multipartBody([{ filename: `${tag}.pdf`, data: pdf }]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    return (res.json() as { documentId: string }[])[0]!.documentId;
  }

  async function getDoc(id: string) {
    return (await env.app.inject({ method: "GET", url: `/api/documents/${id}` })).json() as Record<string, unknown>;
  }

  async function getEvents(id: string) {
    const res = await env.app.inject({ method: "GET", url: `/api/documents/${id}/trace` });
    return (res.json() as { events: { event: string; detail: Record<string, unknown> }[] }).events;
  }

  it("known vendor: template on OCR output commits WITHOUT touching the VLM", async () => {
    await upsertTemplate(env.db, acmeTemplate(), "human_review");
    docling.enqueue(goldenOcrDocling(standard));

    const id = await ingestScan("R-SCAN-1");
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["route"]).toBe("image");
    expect(doc["status"]).toBe("committed");
    const result = doc["result"] as CanonicalInvoice;
    expect(result.invoiceNumber).toBe(wantStandard.invoiceNumber); // from the OCR text
    expect(result.totals).toEqual(wantStandard.totals);
    expect(result.lineItems).toHaveLength(wantStandard.lineItems.length);
    expect(result.lineItems[0]?.description).toBe(wantStandard.lineItems[0]!.description);

    const events = await getEvents(id);
    expect(events.find((e) => e.event === "vendor_resolved")?.detail["matchedBy"]).toBe("ustIdNr");
    expect(events.find((e) => e.event === "template_applied")?.detail["onOcr"]).toBe(true);
    expect(events.some((e) => e.event === "vlm_called")).toBe(false); // GPU stays cold
  });

  it("unknown vendor: VLM parses, result persists an OCR-capable template", async () => {
    docling.enqueue(ocrUnknownVendorDoclingJson());
    vlm.enqueue({ isInvoice: true, invoice: unknownVendorInvoice(), markdown: null });

    const id = await ingestScan("R-SCAN-2");
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["status"]).toBe("committed");
    expect((doc["result"] as CanonicalInvoice).invoiceNumber).toBe("RG-77");

    const events = await getEvents(id);
    expect(events.some((e) => e.event === "vlm_called")).toBe(true);
    expect(events.find((e) => e.event === "template_induced")?.detail["persisted"]).toBe(true);

    const rows = await env.db
      .select()
      .from(vendorTemplates)
      .where(eq(vendorTemplates.ustIdNr, "DE136695976"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("vlm");
    const template = rows[0]!.template as unknown as VendorTemplate;
    expect(template.fields["invoiceNumber"]?.label).toBe("Rechnungs-Nr.");
    // OCR-induced line-item table: the loop stays closed for scanned vendors.
    expect(template.lineItemTable?.columns.description).toBeDefined();
    expect(template.lineItemTable?.columns.lineTotal).toBeDefined();
  });

  it("the persisted VLM template handles the vendor's NEXT scan deterministically", async () => {
    docling.enqueue(ocrUnknownVendorDoclingJson());
    const id = await ingestScan("R-SCAN-3");
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["status"]).toBe("committed");
    const events = await getEvents(id);
    expect(events.find((e) => e.event === "vendor_resolved")?.detail["matchedBy"]).toBe("ustIdNr");
    expect(events.some((e) => e.event === "vlm_called")).toBe(false);
  });
});

describe("Path C — image lane (no VLM)", () => {
  it("unknown vendor without VLM lands in human review with OCR identifiers", async () => {
    const docling = new FakeDocling();
    const env2 = await createTestEnv({ docling });
    try {
      docling.enqueue(ocrUnknownVendorDoclingJson());
      const pdf = await uniqueScannedPdf("R-SCAN-4");
      const { payload, headers } = multipartBody([{ filename: "s.pdf", data: pdf }]);
      const res = await env2.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
      const id = (res.json() as { documentId: string }[])[0]!.documentId;
      await env2.machine.drain();

      const doc = (await env2.app.inject({ method: "GET", url: `/api/documents/${id}` })).json() as Record<string, unknown>;
      expect(doc["status"]).toBe("pending_review");
      const candidate = doc["candidate"] as { invoice: { seller: { ustIdNr: string | null } } };
      expect(candidate.invoice.seller.ustIdNr).toBe("DE136695976");
    } finally {
      await env2.close();
    }
  });
});
