import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTextInvoicePdf, sampleSpec } from "@invex/fixtures";
import type { CanonicalInvoice } from "@invex/core";
import { eq } from "drizzle-orm";
import { vendorTemplates } from "../../src/db/schema";
import { StubVlm } from "../../src/clients/vlm/stub";
import { rasterizePdf } from "../../src/pdf/rasterize";
import { createTestEnv, FakeDocling, multipartBody, type TestEnv } from "../utils/testEnv";
import { alienLabelsDoclingJson, doclingJson } from "../utils/doclingFixtures";

let env: TestEnv;
let docling: FakeDocling;
let vlm: StubVlm;

/** The invoice the stub "reads" off the alien-label document (same arithmetic). */
function vlmInvoice(): CanonicalInvoice {
  return {
    schemaVersion: 1,
    invoiceNumber: "R-2026-0042",
    issueDate: "2026-06-15",
    dueDate: null,
    currency: "EUR",
    locale: "de-DE",
    seller: {
      name: "ACME Bürotechnik GmbH",
      ustIdNr: "DE811907980",
      steuernummer: null,
      ibans: [],
      address: null,
    },
    buyer: null,
    totals: { net: "1148.70", tax: "218.25", gross: "1366.95" },
    vatBreakdown: [{ rate: 19, net: "1148.70", tax: "218.25" }],
    lineItems: [
      { position: 1, description: "Aktenvernichter PS-500", quantity: "2", unit: null, unitPrice: "199.50", taxRate: 19, lineTotal: "399.00" },
      { position: 2, description: "Wartungsvertrag", quantity: "1", unit: null, unitPrice: "480.00", taxRate: 19, lineTotal: "480.00" },
      { position: 3, description: "Toner-Set CMYK", quantity: "3", unit: null, unitPrice: "89.90", taxRate: 19, lineTotal: "269.70" },
    ],
    paymentTerms: null,
  };
}

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

let n = 0;
async function ingestTextPdf(): Promise<string> {
  n++;
  const pdf = await makeTextInvoicePdf(sampleSpec({ invoiceNumber: `R-VLM-${n}` }));
  const { payload, headers } = multipartBody([{ filename: `v${n}.pdf`, data: pdf }]);
  const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
  return (res.json() as { documentId: string }[])[0]!.documentId;
}

async function getDoc(id: string): Promise<Record<string, unknown>> {
  return (await env.app.inject({ method: "GET", url: `/api/documents/${id}` })).json() as Record<string, unknown>;
}

async function getEvents(id: string) {
  const res = await env.app.inject({ method: "GET", url: `/api/documents/${id}/trace` });
  return (res.json() as { events: { event: string; detail: Record<string, unknown> }[] }).events;
}

describe("VLM escalation (stub)", () => {
  it("rules-fail → VLM extract → committed + template learns the alien idiom", async () => {
    docling.enqueue(alienLabelsDoclingJson());
    vlm.enqueue({ isInvoice: true, invoice: vlmInvoice(), markdown: null });

    const id = await ingestTextPdf();
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["status"]).toBe("committed");
    expect(doc["vlmAttempted"]).toBe(true);
    expect((doc["result"] as CanonicalInvoice).totals.gross).toBe("1366.95");

    const events = await getEvents(id);
    const names = events.map((e) => e.event);
    expect(names).toEqual(
      expect.arrayContaining(["escalated", "vlm_called", "reconciled", "committed", "template_induced"]),
    );

    // The VLM-sourced template anchors the vendor's ALIEN labels — the GPU
    // never sees this vendor again (briefing §6).
    const rows = await env.db
      .select()
      .from(vendorTemplates)
      .where(eq(vendorTemplates.ustIdNr, "DE811907980"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("vlm");
    const template = rows[0]!.template as {
      fields: Record<string, { label?: string }>;
    };
    expect(template.fields["invoiceNumber"]?.label).toBe("Vorgangskennung");
    expect(template.fields["totals.gross"]?.label).toBe("Absolutwert");
  });

  it("uncertain classification → VLM says non-invoice → Markdown export", async () => {
    // Partial signals only: heading + tax id → uncertain band (score 5).
    docling.enqueue(
      doclingJson([
        { text: "Rechnung", x: 380, yTop: 60, label: "section_header" },
        { text: "USt-IdNr.: DE136695976", x: 50, yTop: 92 },
        { text: "Hiermit bestätigen wir den Eingang Ihrer Unterlagen.", x: 50, yTop: 200 },
      ]),
    );
    vlm.enqueue({ isInvoice: false, invoice: null, markdown: "# Eingangsbestätigung\nKein Rechnungsdokument." });

    const id = await ingestTextPdf();
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["status"]).toBe("exported_markdown");
    const events = await getEvents(id);
    expect(events.find((e) => e.event === "escalated")?.detail["reason"]).toBe("uncertain_classification");
    expect(events.find((e) => e.event === "markdown_exported")?.detail["reason"]).toBe("vlm_non_invoice");
    const md = await env.app.inject({ method: "GET", url: `/api/documents/${id}/markdown` });
    expect((md.json() as { markdown: string }).markdown).toContain("Eingangsbestätigung");
  });
});

describe("rasterizer", () => {
  it("renders PDF pages to PNG buffers", async () => {
    const pdf = await makeTextInvoicePdf(sampleSpec());
    const images = await rasterizePdf(pdf, { dpi: 96, maxPages: 3 });
    expect(images.length).toBe(1);
    // PNG magic bytes
    expect([...images[0]!.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(images[0]!.byteLength).toBeGreaterThan(5000);
  });
});
