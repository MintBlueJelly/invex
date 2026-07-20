import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeScannedPdf, sampleSpec } from "@invex/fixtures";
import type { CanonicalInvoice, VendorTemplate } from "@invex/core";
import { eq } from "drizzle-orm";
import { vendorTemplates } from "../../src/db/schema";
import { upsertTemplate } from "../../src/db/repos/templates";
import { StubVlm } from "../../src/clients/vlm/stub";
import { createTestEnv, FakeDocling, multipartBody, type TestEnv } from "../utils/testEnv";
import { ocrInvoiceDoclingJson, ocrUnknownVendorDoclingJson } from "../utils/doclingFixtures";

/** Template for the known scanned vendor (as human review / VLM would have induced it). */
function acmeTemplate(): VendorTemplate {
  return {
    templateVersion: 1,
    vendorIds: { ustIdNr: "DE811907980", displayName: "ACME Bürotechnik GmbH" },
    locale: { decimal: ",", dateFormats: ["dd.MM.yyyy"] },
    fields: {
      invoiceNumber: { label: "Rechnungs-Nr.", valuePattern: "R-\\d+-\\d+" },
      issueDate: { label: "Rechnungsdatum", valuePattern: "\\d{2}\\.\\d{2}\\.\\d{4}" },
      "totals.net": { label: "Zwischensumme (netto)", valuePattern: "-?[\\d.,]+" },
      "totals.tax": { label: "MwSt. 19%", valuePattern: "-?[\\d.,]+" },
      "totals.gross": { label: "Gesamtbetrag", valuePattern: "-?[\\d.,]+" },
    },
    lineItemTable: {
      headerSignature: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
      columns: { position: 0, description: 1, quantity: 2, unitPrice: 3, lineTotal: 4 },
      descriptionContinuation: "rowsWithoutPosNumber",
    },
  };
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

describe("Path C — image lane (VLM enabled)", () => {
  let env: TestEnv;
  let docling: FakeDocling;
  let vlm: StubVlm;
  let n = 0;

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

  async function ingestScan(invoiceNumber: string): Promise<string> {
    n++;
    const pdf = await makeScannedPdf(sampleSpec({ invoiceNumber }));
    const { payload, headers } = multipartBody([{ filename: `scan${n}.pdf`, data: pdf }]);
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
    docling.enqueue(ocrInvoiceDoclingJson());

    const id = await ingestScan("R-SCAN-1");
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["route"]).toBe("image");
    expect(doc["status"]).toBe("committed");
    const result = doc["result"] as CanonicalInvoice;
    expect(result.invoiceNumber).toBe("R-2026-0042"); // from the OCR text
    expect(result.totals).toEqual({ net: "1148.70", tax: "218.25", gross: "1366.95" });
    expect(result.lineItems).toHaveLength(3);
    expect(result.lineItems[0]?.description).toBe("Aktenvernichter PS-500");

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
      const pdf = await makeScannedPdf(sampleSpec({ invoiceNumber: "R-SCAN-4" }));
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
