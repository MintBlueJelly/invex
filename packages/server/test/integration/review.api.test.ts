import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanonicalInvoice } from "@invex/core";
import { eq } from "drizzle-orm";
import { escalations, vendorTemplates } from "../../src/db/schema";
import { createTestEnv, FakeDocling, multipartBody, type TestEnv } from "../utils/testEnv";
import { uniqueTextPdf } from "../utils/textPdfVariant";
import { alienVendorDoclingJson, alienVendorInvoice } from "../utils/alienVendorFixture";

let env: TestEnv;
let docling: FakeDocling;
let pendingId: string;

beforeAll(async () => {
  docling = new FakeDocling();
  env = await createTestEnv({ docling }); // VLM off → alien doc → pending_review

  docling.enqueue(alienVendorDoclingJson());
  const pdf = await uniqueTextPdf("R-REVIEW-1");
  const { payload, headers } = multipartBody([{ filename: "r.pdf", data: pdf }]);
  const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
  pendingId = (res.json() as { documentId: string }[])[0]!.documentId;
  await env.machine.drain();
});

afterAll(async () => {
  await env.close();
});

describe("human review API (briefing §7)", () => {
  it("lists pending documents with vendor guess and violation summary", async () => {
    const res = await env.app.inject({ method: "GET", url: "/api/review" });
    const list = res.json() as { id: string; violationSummary: string[] }[];
    const entry = list.find((e) => e.id === pendingId);
    expect(entry).toBeDefined();
    expect(entry!.violationSummary.length).toBeGreaterThan(0);
  });

  it("serves the side-by-side payload (candidate + violations + pdf url)", async () => {
    const res = await env.app.inject({ method: "GET", url: `/api/review/${pendingId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { candidate: unknown; pdfUrl: string };
    expect(body.candidate).toBeTruthy();
    expect(body.pdfUrl).toBe(`/api/documents/${pendingId}/pdf`);
  });

  it("rejects an arithmetically invalid or malformed correction", async () => {
    const res = await env.app.inject({
      method: "PUT",
      url: `/api/review/${pendingId}`,
      payload: { invoiceNumber: "" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: string[] }).issues.length).toBeGreaterThan(0);
  });

  it("commit writes the invoice AND creates/updates the vendor template", async () => {
    const res = await env.app.inject({
      method: "PUT",
      url: `/api/review/${pendingId}`,
      payload: alienVendorInvoice(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; templateId: string | null };
    expect(body.status).toBe("committed");
    expect(body.templateId).not.toBeNull();

    const doc = (await env.app.inject({ method: "GET", url: `/api/documents/${pendingId}` })).json() as Record<string, unknown>;
    expect(doc["status"]).toBe("committed");
    expect((doc["result"] as CanonicalInvoice).totals.gross).toBe("1366.95");

    // §7 feedback edge: the template anchors the vendor's alien idiom.
    const rows = await env.db.select().from(vendorTemplates).where(eq(vendorTemplates.ustIdNr, "DE811907980"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("human_review");
    const fields = (rows[0]!.template as { fields: Record<string, { label?: string }> }).fields;
    expect(fields["invoiceNumber"]?.label).toBe("Vorgangskennung");

    // Escalations resolved.
    const esc = await env.db.select().from(escalations).where(eq(escalations.documentId, pendingId));
    expect(esc.length).toBeGreaterThan(0);
    expect(esc.every((e) => e.resolvedAt !== null)).toBe(true);
    expect(esc[0]!.resolution).toBe("human_review");
  });

  it("refuses commits on documents that are not pending review", async () => {
    const res = await env.app.inject({
      method: "PUT",
      url: `/api/review/${pendingId}`,
      payload: alienVendorInvoice(),
    });
    expect(res.statusCode).toBe(409);
  });
});
