import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTextInvoicePdf, sampleSpec } from "@invex/fixtures";
import { eq } from "drizzle-orm";
import { vendorTemplates } from "../../src/db/schema";
import { createTestEnv, FakeDocling, multipartBody, type TestEnv } from "../utils/testEnv";
import {
  alienLabelsDoclingJson,
  garbageDoclingJson,
  invoiceDoclingJson,
  letterDoclingJson,
  multiInvoiceDoclingJson,
} from "../utils/doclingFixtures";

/**
 * Path B integration: real worker loop + real mapper/gate/classifier/rules/
 * template engines over PGlite; only docling-serve is faked (queue of
 * DoclingDocument JSON responses).
 */

let env: TestEnv;
let docling: FakeDocling;

beforeAll(async () => {
  docling = new FakeDocling();
  env = await createTestEnv({ docling });
});

afterAll(async () => {
  await env.close();
});

let ingestCounter = 0;

/** The PDF bytes only drive triage (text route); extraction sees the fake docling JSON. */
async function ingestTextPdf(): Promise<string> {
  ingestCounter++;
  const pdf = await makeTextInvoicePdf(sampleSpec({ invoiceNumber: `R-INGEST-${ingestCounter}` }));
  const { payload, headers } = multipartBody([{ filename: `t${ingestCounter}.pdf`, data: pdf }]);
  const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
  return (res.json() as { documentId: string }[])[0]!.documentId;
}

async function getDoc(id: string): Promise<Record<string, unknown>> {
  const res = await env.app.inject({ method: "GET", url: `/api/documents/${id}` });
  return res.json() as Record<string, unknown>;
}

async function getEvents(id: string): Promise<{ event: string; detail: Record<string, unknown> }[]> {
  const res = await env.app.inject({ method: "GET", url: `/api/documents/${id}/trace` });
  return (res.json() as { events: { event: string; detail: Record<string, unknown> }[] }).events;
}

describe("Path B — text lane", () => {
  it("first-seen vendor: rule engine extracts, solver closes, template is induced", async () => {
    docling.enqueue(invoiceDoclingJson(), "# Rechnung R-2026-0042");
    const id = await ingestTextPdf();
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["status"]).toBe("committed");
    const result = doc["result"] as {
      invoiceNumber: string;
      totals: Record<string, string>;
      lineItems: { description: string; taxRate: number | null }[];
      seller: { name: string | null; ustIdNr: string | null; ibans: string[] };
    };
    expect(result.invoiceNumber).toBe("R-2026-0042");
    expect(result.totals).toEqual({ net: "1148.70", tax: "218.25", gross: "1366.95" });
    expect(result.lineItems).toHaveLength(3);
    expect(result.lineItems[1]?.description).toBe("Wartungsvertrag Bürogeräte, Laufzeit 12 Monate");
    expect(result.lineItems.every((l) => l.taxRate === 19)).toBe(true);
    expect(result.seller.ustIdNr).toBe("DE811907980");
    expect(result.seller.ibans).toEqual(["DE02120300000000202051"]);

    const events = await getEvents(id);
    const names = events.map((e) => e.event);
    expect(names).toEqual(
      expect.arrayContaining(["text_gate", "classified", "vendor_resolved", "rules_applied", "reconciled", "committed", "template_induced"]),
    );
    expect(events.find((e) => e.event === "classified")?.detail["band"]).toBe("invoice");
    expect(events.find((e) => e.event === "vendor_resolved")?.detail["templateId"]).toBeUndefined();

    // Rule-engine success persisted a vendor template (briefing §3 source 3).
    const templates = await env.db
      .select()
      .from(vendorTemplates)
      .where(eq(vendorTemplates.ustIdNr, "DE811907980"));
    expect(templates).toHaveLength(1);
    expect(templates[0]!.source).toBe("rule_engine");
  });

  it("second invoice from the same vendor resolves and applies the template", async () => {
    docling.enqueue(invoiceDoclingJson({ invoiceNumber: "R-2026-0099", issueDate: "20.06.2026" }));
    const id = await ingestTextPdf();
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["status"]).toBe("committed");
    expect((doc["result"] as { invoiceNumber: string }).invoiceNumber).toBe("R-2026-0099");

    const events = await getEvents(id);
    const vendor = events.find((e) => e.event === "vendor_resolved");
    expect(vendor?.detail["matchedBy"]).toBe("ustIdNr");
    expect(events.some((e) => e.event === "template_applied")).toBe(true);
  });

  it("non-invoice exports Markdown (classifier band non_invoice)", async () => {
    docling.enqueue(letterDoclingJson(), "## Allgemeine Geschäftsbedingungen\n...");
    const id = await ingestTextPdf();
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["status"]).toBe("exported_markdown");
    const md = await env.app.inject({ method: "GET", url: `/api/documents/${id}/markdown` });
    expect(md.statusCode).toBe(200);
    expect((md.json() as { markdown: string }).markdown).toContain("Geschäftsbedingungen");
  });

  it("garbage text layer reroutes to Path C via the gate", async () => {
    docling.enqueue(garbageDoclingJson()); // text lane: gate trips
    docling.enqueue(garbageDoclingJson()); // image lane: OCR is garbage too
    const id = await ingestTextPdf();
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["route"]).toBe("image");
    // No vendor ids in the OCR, no VLM in this env → last resort.
    expect(doc["status"]).toBe("pending_review");
    const events = await getEvents(id);
    const gate = events.find((e) => e.event === "text_gate");
    expect(gate?.detail["verdict"]).toBe("garbage");
    expect(Number(gate?.detail["cidTokens"])).toBeGreaterThan(0);
  });

  it("alien vendor idiom fails deterministically and escalates to review (VLM off)", async () => {
    docling.enqueue(alienLabelsDoclingJson());
    const id = await ingestTextPdf();
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["status"]).toBe("pending_review");
    const violations = doc["violations"] as { constraint: string }[];
    expect(violations.length).toBeGreaterThan(0);
    const events = await getEvents(id);
    expect(events.find((e) => e.event === "escalated")?.detail["to"]).toBe("human_review");
  });

  it("multi-invoice PDF segments into children that commit independently", async () => {
    docling.enqueue(multiInvoiceDoclingJson());
    const id = await ingestTextPdf();
    await env.machine.drain();

    const parent = await getDoc(id);
    expect(parent["status"]).toBe("segmented");

    const res = await env.app.inject({ method: "GET", url: "/api/documents?limit=100" });
    const all = res.json() as { id: string; parentId: string | null; status: string }[];
    const children = all.filter((d) => d.parentId === id);
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.status === "committed")).toBe(true);

    const numbers = await Promise.all(
      children.map(async (c) => ((await getDoc(c.id))["result"] as { invoiceNumber: string }).invoiceNumber),
    );
    expect(numbers.sort()).toEqual(["R-A-1", "R-B-2"]);
  });
});
