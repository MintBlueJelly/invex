import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goldenDocling, isSynthetic, layoutInvoice, loadGolden, renderDoclingJson } from "@invex/fixtures";
import { eq } from "drizzle-orm";
import { vendorTemplates } from "../../src/db/schema";
import { createTestEnv, FakeDocling, multipartBody, type TestEnv } from "../utils/testEnv";
import { uniqueTextPdf } from "../utils/textPdfVariant";
import { withInvoiceNumber } from "../utils/literalVariants";
import { alienVendorDoclingJson } from "../utils/alienVendorFixture";
import { rawDoclingDocument } from "../utils/rawDoclingDocument";

/**
 * Path B integration: real worker loop + real mapper/gate/classifier/rules/
 * template engines over PGlite; only docling-serve is faked (queue of
 * DoclingDocument JSON responses).
 *
 * de-standard-19 is the workhorse golden here: it is the one scenario known to
 * clear the text gate (INVEX-047 rejects several others as garbage), so any
 * test that needs the deterministic path to actually commit uses it.
 */

const standard = loadGolden("de-standard-19");
if (!isSynthetic(standard)) throw new Error("de-standard-19 golden must be synthetic");
const standardDoc = standard.render.doc;
const wantStandard = standard.expected.canonical!;

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
  const pdf = await uniqueTextPdf(`R-INGEST-${ingestCounter}`);
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

/** Non-invoice covering letter: dense prose only, no letterhead/table noise.
 * The golden equivalent (non-invoice-letter) trips the text gate (INVEX-047)
 * because its realistic letterhead/address lines dilute the gate's
 * dictionary-hit ratio below threshold — so it cannot serve as a currently-
 * PASSING fixture. This mirrors its content shape without that noise. */
function letterDoclingJson(): unknown {
  return rawDoclingDocument([
    { text: "Allgemeine Geschäftsbedingungen", x: 50, yTop: 70, label: "section_header" },
    { text: "Die nachfolgenden Bedingungen gelten für alle Lieferungen und Leistungen.", x: 50, yTop: 110 },
    { text: "Angebote sind freibleibend und unverbindlich.", x: 50, yTop: 126 },
    { text: "Lieferfristen sind nur verbindlich, wenn sie schriftlich bestätigt wurden.", x: 50, yTop: 142 },
    { text: "Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts.", x: 50, yTop: 158 },
  ]);
}

/** Garbage text layer (broken upstream OCR): must trip the gate. No golden
 * models this — it is not a realistic invoice at all. */
function garbageDoclingJson(): unknown {
  const lines = Array.from({ length: 20 }, (_, i) => ({
    text: `(cid:${i * 7}) (cid:${i * 11}) (cid:${i * 13}) qzwx vbnk jhgf`,
    x: 50,
    yTop: 60 + i * 16,
  }));
  return rawDoclingDocument(lines);
}

/**
 * Two invoices in one PDF (page counter restarts) + trailing AGB page — the
 * segmenter's "Seite 1 von 1" reset is the boundary signal. No golden models
 * multi-invoice segmentation, so this is built directly from positioned
 * lines/tables rather than forced through the single-invoice layout seam.
 */
function multiInvoiceDoclingJson(): unknown {
  const invoicePage = (page: number, nr: string) => [
    { text: "Rechnung", x: 380, yTop: 60, label: "section_header", page },
    { text: `Rechnungs-Nr.: ${nr}`, x: 380, yTop: 88, page },
    { text: "Rechnungsdatum: 15.06.2026", x: 380, yTop: 104, page },
    { text: "Seite 1 von 1", x: 50, yTop: 800, page },
    { text: "Gesamtbetrag: 119,00 EUR", x: 330, yTop: 632, page },
    { text: "MwSt. 19%: 19,00 EUR", x: 330, yTop: 616, page },
    { text: "Zwischensumme (netto): 100,00 EUR", x: 330, yTop: 600, page },
    { text: "USt-IdNr.: DE811907980", x: 50, yTop: 92, page },
  ];
  const lines = [
    ...invoicePage(1, "R-A-1"),
    ...invoicePage(2, "R-B-2"),
    { text: "Allgemeine Geschäftsbedingungen", x: 50, yTop: 70, label: "section_header", page: 3 },
    { text: "Es gilt deutsches Recht.", x: 50, yTop: 110, page: 3 },
  ];
  const table = (page: number) => ({
    page,
    yTop: 240,
    headers: ["Pos", "Bezeichnung", "Menge", "Einzelpreis", "Gesamt"],
    rows: [["1", "Beratung", "1", "100,00", "100,00"]],
  });
  return rawDoclingDocument(lines, [table(1), table(2)], 3);
}

describe("Path B — text lane", () => {
  it("first-seen vendor: rule engine extracts, solver closes, template is induced", async () => {
    docling.enqueue(goldenDocling(standard), `# ${standardDoc.headingText}`);
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
    expect(result.invoiceNumber).toBe(wantStandard.invoiceNumber);
    expect(result.totals).toEqual(wantStandard.totals);
    expect(result.lineItems).toHaveLength(wantStandard.lineItems.length);
    expect(result.lineItems[1]?.description).toBe(wantStandard.lineItems[1]!.description);
    expect(result.lineItems.every((l) => l.taxRate === 19)).toBe(true);
    expect(result.seller.ustIdNr).toBe(wantStandard.seller.ustIdNr);
    expect(result.seller.ibans).toEqual(wantStandard.seller.ibans);

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
      .where(eq(vendorTemplates.ustIdNr, wantStandard.seller.ustIdNr!));
    expect(templates).toHaveLength(1);
    expect(templates[0]!.source).toBe("rule_engine");
  });

  it("second invoice from the same vendor resolves and applies the template", async () => {
    const variant = withInvoiceNumber(standardDoc, "R-2026-0099", "20.06.2026");
    docling.enqueue(renderDoclingJson(layoutInvoice(variant)));
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
    docling.enqueue(alienVendorDoclingJson());
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
