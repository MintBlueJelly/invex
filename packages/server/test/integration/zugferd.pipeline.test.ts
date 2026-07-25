import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isSynthetic,
  loadGolden,
  makeMalformedZugferdPdf,
  makeScannedPdf,
  makeTextInvoicePdf,
  makeZugferdPdf,
  type InvoiceSpec,
} from "@invex/fixtures";
import { createTestEnv, multipartBody, type TestEnv } from "../utils/testEnv";

/**
 * Full-pipeline integration (no external services): ingest via HTTP, real
 * worker loop over PGlite, assertions on status trajectories via the trace.
 *
 * There is no golden renderer for a ZUGfERD/Factur-X PDF (no CII-XML seam in
 * goldens.ts yet), so this file keeps generating real ZUGfERD/text/scanned
 * PDFs via the fixtures package — but the EXPECTED totals below come from
 * de-standard-19's independently-authored canonical, not from computeInvoice.
 * `specWith()` only reshapes that same truth into the InvoiceSpec shape the
 * PDF/XML generators need.
 */

const standard = loadGolden("de-standard-19");
if (!isSynthetic(standard)) throw new Error("de-standard-19 golden must be synthetic");
const canonical = standard.expected.canonical!;

function specWith(invoiceNumber: string): InvoiceSpec {
  return {
    invoiceNumber,
    issueDate: canonical.issueDate,
    dueDate: canonical.dueDate ?? undefined,
    currency: canonical.currency,
    seller: {
      name: canonical.seller.name,
      ustIdNr: canonical.seller.ustIdNr ?? undefined,
      iban: canonical.seller.ibans[0],
      street: canonical.seller.address?.street ?? undefined,
      postalCode: canonical.seller.address?.postalCode ?? undefined,
      city: canonical.seller.address?.city ?? undefined,
    },
    lines: canonical.lineItems.map((l) => ({
      description: l.description,
      quantity: l.quantity ?? undefined,
      unitPrice: l.unitPrice ?? undefined,
      taxRate: l.taxRate ?? undefined,
    })),
  };
}

let env: TestEnv;

beforeAll(async () => {
  // Isolate Path A: no text/image lanes, so misrouted docs visibly wait at "routed".
  env = await createTestEnv({
    registry: (r) => {
      delete r.lanes.text;
      delete r.lanes.image;
    },
  });
});

afterAll(async () => {
  await env.close();
});

async function ingest(filename: string, data: Uint8Array): Promise<string> {
  const { payload, headers } = multipartBody([{ filename, data }]);
  const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
  expect(res.statusCode).toBe(202);
  const body = res.json() as { documentId: string; deduplicated: boolean }[];
  return body[0]!.documentId;
}

async function getDoc(id: string): Promise<Record<string, unknown>> {
  const res = await env.app.inject({ method: "GET", url: `/api/documents/${id}` });
  return res.json() as Record<string, unknown>;
}

async function getTrace(id: string): Promise<{ event: string; detail: Record<string, unknown> }[]> {
  const res = await env.app.inject({ method: "GET", url: `/api/documents/${id}/trace` });
  return (res.json() as { events: { event: string; detail: Record<string, unknown> }[] }).events;
}

describe("triage routing", () => {
  it("routes zugferd / text / image fixtures to their lanes with reasons", async () => {
    const zug = await ingest("zugferd.pdf", await makeZugferdPdf(specWith("R-ROUTE-1")));
    const txt = await ingest("text.pdf", await makeTextInvoicePdf(specWith("R-ROUTE-2")));
    const img = await ingest("scan.pdf", await makeScannedPdf(specWith("R-ROUTE-3")));

    await env.machine.drain();

    expect((await getDoc(txt))["route"]).toBe("text");
    expect((await getDoc(img))["route"]).toBe("image");
    expect((await getDoc(zug))["route"]).toBe("zugferd");

    const txtRouted = (await getTrace(txt)).find((e) => e.event === "routed");
    expect(txtRouted?.detail["route"]).toBe("text");
    expect(Number(txtRouted?.detail["charCount"])).toBeGreaterThan(50);

    const imgRouted = (await getTrace(img)).find((e) => e.event === "routed");
    expect(Number(imgRouted?.detail["charCount"])).toBeLessThanOrEqual(50);

    const zugRouted = (await getTrace(zug)).find((e) => e.event === "routed");
    expect(zugRouted?.detail["xmlAttachment"]).toBe("factur-x.xml");

    // No text/image lane registered yet: those documents wait at "routed".
    expect((await getDoc(txt))["status"]).toBe("routed");
    expect((await getDoc(img))["status"]).toBe("routed");
  });
});

describe("Path A — ZUGfERD lane", () => {
  it("parses embedded CII, reconciles through the shared solver, and commits", async () => {
    const spec = specWith("R-ZUG-OK");
    const id = await ingest("ok.pdf", await makeZugferdPdf(spec));
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["status"]).toBe("committed");
    const result = doc["result"] as {
      invoiceNumber: string;
      totals: { net: string; tax: string; gross: string };
      seller: { ustIdNr: string | null; ibans: string[] };
      vatBreakdown: { rate: number }[];
      lineItems: { description: string; taxRate: number | null }[];
    };
    expect(result.invoiceNumber).toBe("R-ZUG-OK");
    expect(result.totals).toEqual(canonical.totals);
    expect(result.seller.ustIdNr).toBe(spec.seller.ustIdNr);
    expect(result.seller.ibans).toEqual([spec.seller.iban]);
    expect(result.lineItems).toHaveLength(canonical.lineItems.length);
    expect(result.vatBreakdown).toHaveLength(canonical.vatBreakdown.length);

    const events = (await getTrace(id)).map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining(["ingested", "routed", "xml_parsed", "reconciled", "committed"]),
    );
  });

  it("falls through to the text lane on malformed XML — never hard-errors (§2)", async () => {
    const id = await ingest("broken.pdf", await makeMalformedZugferdPdf(specWith("R-ZUG-BROKEN")));
    await env.machine.drain();

    const doc = await getDoc(id);
    expect(doc["route"]).toBe("text");
    expect(doc["status"]).toBe("routed"); // waiting for the (not yet registered) text lane
    expect(doc["error"]).toBeNull(); // graceful degradation, not a stage error

    const events = (await getTrace(id)).map((e) => e.event);
    expect(events).toContain("xml_fallthrough");
    expect(events).not.toContain("stage_error");

    // §8: the fallthrough left a queryable escalation row.
    const esc = await env.app.inject({ method: "GET", url: `/api/escalations?documentId=${id}` });
    const rows = esc.json() as { stage: string }[];
    expect(rows.some((r) => r.stage === "xml_fallthrough")).toBe(true);
  });

  it("deduplicates identical re-ingests by content hash", async () => {
    const pdf = await makeZugferdPdf(specWith("R-DEDUP"));
    const first = await ingest("a.pdf", pdf);
    const { payload, headers } = multipartBody([{ filename: "a-again.pdf", data: pdf }]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    const body = res.json() as { documentId: string; deduplicated: boolean }[];
    expect(body[0]!.documentId).toBe(first);
    expect(body[0]!.deduplicated).toBe(true);
  });
});
