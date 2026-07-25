import { goldenDocling, goldenPdf, isSynthetic, loadGoldens } from "@invex/fixtures";
import { describe, expect, it } from "../utils/fixture";
import { multipartBody } from "../utils/testEnv";

/**
 * Every golden scenario, through the real pipeline.
 *
 * This is what makes the golden corpus worth having: the printed page and the
 * expected canonical invoice were authored independently, so agreement here is
 * evidence about the PIPELINE rather than about the generator's arithmetic.
 * The suite this replaces compared `out/expected.json` against fixtures that
 * both came out of `computeInvoice()`.
 *
 * Only docling is faked — the mapper, gate, segmenter, classifier, rule engine,
 * template engine and solver all run for real over PGlite.
 */

// Real-PDF scenarios need a live docling and belong to the smoke harness
// (pnpm smoke --strict-canonical), not to this in-process lane.
const goldens = loadGoldens().filter(isSynthetic);
const invoiceGoldens = goldens.filter((g) => g.expected.canonical !== null);

interface Detail {
  status: string;
  result: Record<string, unknown> | null;
  route: string | null;
  violations: { constraint: string }[] | null;
}

describe("golden scenarios through the pipeline", () => {
  it("the corpus is not empty", () => {
    expect(goldens.length).toBeGreaterThanOrEqual(8);
  });

  for (const g of goldens) {
    // A scenario the pipeline does not yet satisfy keeps its truthful
    // expectation and becomes an it.fails() pin — red the day it is fixed.
    const run = g.knownBug ? it.fails : it;
    const label = g.knownBug ? `${g.id}: ${g.title}  \u27e8known-bug ${g.knownBug}\u27e9` : `${g.id}: ${g.title}`;
    run(label, async ({ env, docling }) => {
      // The PDF bytes drive triage; extraction sees the docling JSON. Both are
      // rendered from the SAME layout, so they cannot describe different pages.
      docling.enqueue(goldenDocling(g), `# ${g.render.doc.headingText}`);

      const pdf = await goldenPdf(g);
      const { payload, headers } = multipartBody([{ filename: `${g.id}.pdf`, data: pdf }]);
      const ingest = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
      expect(ingest.statusCode).toBe(202);
      const id = (ingest.json() as { documentId: string }[])[0]!.documentId;

      await env.machine.drain();

      const doc = (await env.app.inject({ method: "GET", url: `/api/documents/${id}` })).json() as Detail;
      const events = (
        (await env.app.inject({ method: "GET", url: `/api/documents/${id}/trace` })).json() as {
          events: { event: string }[];
        }
      ).events.map((e) => e.event);

      const smoke = g.expected.smoke ?? {};
      if (smoke.route) expect(doc.route, "route").toBe(smoke.route);
      if (smoke.terminalStatus) expect(doc.status, "terminal status").toBe(smoke.terminalStatus);
      for (const e of smoke.hasEvents ?? []) expect(events, `expected event ${e}`).toContain(e);
      for (const e of smoke.notEvents ?? []) expect(events, `unexpected event ${e}`).not.toContain(e);

      // Unconsumed docling responses would mean the document never reached the
      // lane this scenario is about; assertDrained() in the fixture catches that.
      expect(docling.calls.length).toBeGreaterThan(0);
    });
  }
});

describe("committed invoices match the hand-authored canonical", () => {
  for (const g of invoiceGoldens) {
    // Scenarios that are expected to commit are the ones we can compare
    // field-by-field. Others still assert route/status/events above.
    const expectsCommit = g.expected.smoke?.terminalStatus === "committed";
    const t = !expectsCommit ? it.skip : g.knownBug ? it.fails : it;

    t(`${g.id}: totals and line items`, async ({ env, docling }) => {
      docling.enqueue(goldenDocling(g), `# ${g.render.doc.headingText}`);
      const pdf = await goldenPdf(g);
      const { payload, headers } = multipartBody([{ filename: `${g.id}.pdf`, data: pdf }]);
      const id = (
        (await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers })).json() as {
          documentId: string;
        }[]
      )[0]!.documentId;
      await env.machine.drain();

      const doc = (await env.app.inject({ method: "GET", url: `/api/documents/${id}` })).json() as Detail;
      expect(doc.status, `violations: ${JSON.stringify(doc.violations)}`).toBe("committed");

      const want = g.expected.canonical!;
      const got = doc.result as unknown as typeof want;

      expect(got.totals, "totals").toEqual(want.totals);
      expect(got.invoiceNumber, "invoiceNumber").toBe(want.invoiceNumber);
      expect(got.issueDate, "issueDate").toBe(want.issueDate);
      expect(got.vatBreakdown, "vatBreakdown").toEqual(want.vatBreakdown);
      expect(got.lineItems.map((l) => l.description), "line descriptions").toEqual(
        want.lineItems.map((l) => l.description),
      );
      expect(got.lineItems.map((l) => l.lineTotal), "line totals").toEqual(
        want.lineItems.map((l) => l.lineTotal),
      );
    });
  }
});
