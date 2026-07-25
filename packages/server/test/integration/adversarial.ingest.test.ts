import { createHash } from "node:crypto";
import {
  adversarialFilenames,
  goldenDocling,
  goldenPdf,
  loadGolden,
  makeHeaderOnlyPdf,
  makeHugeMediaBoxPdf,
  makeManyPagesPdf,
  makeMultiXmlAttachmentPdf,
  makeNotAPdf,
  makeTruncatedPdf,
  makeWrongTypeAttachmentPdf,
  makeXmlBombZugferdPdf,
  makeZeroBytePdf,
} from "@invex/fixtures";
import { describe, expect, it } from "../utils/fixture";
import { createTestEnv, multipartBody } from "../utils/testEnv";
import { FakeDocling } from "../utils/doubles";
import { rawDoclingDocument } from "../utils/rawDoclingDocument";
import { findReusableByHash } from "../../src/db/repos/documents";
import type { DocumentStatus } from "../../src/db/schema";
import { knownBug } from "../../../../test-utils/knownBug";

/**
 * The adversarial corpus, ingested through the real HTTP route and the real
 * worker loop (PGlite, no external services). docs/deployment.md's poison-document
 * failure mode exists because InvEx is one replica on `Recreate` with an
 * in-process worker: a document that kills the process instead of failing it
 * rolls its claim back WITHOUT incrementing `attempts`, and claims are
 * oldest-first, so it wedges the ENTIRE queue on every restart. n8n reading
 * email attachments is the intended batch entry point (README.md/docs/deployment.md)
 * — arbitrary bytes from the public internet, unreviewed. Every case here is
 * something that arrives in an inbox sooner or later.
 *
 * The acceptance criterion for this file is the second describe block below:
 * ingest the whole corpus, then prove a normal invoice still commits after it.
 */

const TERMINAL: readonly DocumentStatus[] = [
  "committed",
  "exported_markdown",
  "segmented",
  "pending_review",
  "failed",
];

const STANDARD = loadGolden("de-standard-19");

interface Detail {
  status: DocumentStatus;
  result: Record<string, unknown> | null;
  violations: unknown;
  error: string | null;
}

interface Trace {
  events: { event: string }[];
}

type UploadResult = { documentId: string; filename: string; deduplicated: boolean };

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface Case {
  name: string;
  filename: string;
  build: () => Uint8Array | Promise<Uint8Array>;
}

/**
 * One entry per generator in packages/fixtures/src/generators/adversarial.ts.
 * `build` is a thunk rather than a resolved value so cases can be registered
 * as individual `it()`s synchronously (vitest collects tests at module load)
 * while the actual (async) byte-building happens inside each test body.
 */
function corpusCases(): Case[] {
  return [
    { name: "zero-byte", filename: "empty.pdf", build: () => makeZeroBytePdf() },
    { name: "header-only", filename: "header-only.pdf", build: () => makeHeaderOnlyPdf() },
    {
      name: "truncated-golden-invoice",
      filename: "truncated.pdf",
      build: async () => makeTruncatedPdf(await goldenPdf(STANDARD)),
    },
    { name: "not-a-pdf (png bytes)", filename: "photo.pdf", build: () => makeNotAPdf("png") },
    { name: "not-a-pdf (zip bytes)", filename: "archive.pdf", build: () => makeNotAPdf("zip") },
    { name: "not-a-pdf (html bytes)", filename: "page.pdf", build: () => makeNotAPdf("html") },
    { name: "not-a-pdf (plain text)", filename: "note.pdf", build: () => makeNotAPdf("text") },
    { name: "huge-mediabox (14400x14400pt)", filename: "huge.pdf", build: () => makeHugeMediaBoxPdf() },
    { name: "many-pages (500 blank pages)", filename: "many-pages.pdf", build: () => makeManyPagesPdf(500) },
    {
      name: "zugferd xml-bomb (billion-laughs)",
      filename: "invoice-1.pdf",
      build: () => makeXmlBombZugferdPdf("billion-laughs"),
    },
    {
      name: "zugferd xml-bomb (deep-nesting)",
      filename: "invoice-2.pdf",
      build: () => makeXmlBombZugferdPdf("deep-nesting"),
    },
    {
      name: "zugferd xml-bomb (external-entity)",
      filename: "invoice-3.pdf",
      build: () => makeXmlBombZugferdPdf("external-entity"),
    },
    { name: "wrong-type zugferd attachment (PNG as factur-x.xml)", filename: "wrong-type.pdf", build: () => makeWrongTypeAttachmentPdf() },
    { name: "two rival zugferd attachments", filename: "multi-xml.pdf", build: () => makeMultiXmlAttachmentPdf() },
  ];
}

describe("adversarial corpus — per-file behaviour", () => {
  it("the corpus is not empty", () => {
    expect(corpusCases().length).toBeGreaterThanOrEqual(10);
  });

  for (const c of corpusCases()) {
    it(`${c.name}: reaches a terminal status (or is safely rejected at ingest), never stuck`, async ({ env }) => {
      const data = await c.build();
      const { payload, headers } = multipartBody([{ filename: c.filename, data }]);
      const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });

      if (data.byteLength === 0) {
        // Alone in the request, ingest silently drops the 0-byte part (see
        // http/app.ts's `if (buf.length === 0) continue`), leaving nothing to
        // store — a safe rejection, not a document.
        expect(res.statusCode, c.name).toBe(400);
      } else {
        expect(res.statusCode, c.name).toBe(202);
        const id = (res.json() as UploadResult[])[0]!.documentId;

        await env.machine.drain();

        const doc = (await env.app.inject({ method: "GET", url: `/api/documents/${id}` })).json() as Detail;
        expect(TERMINAL, `${c.name}: stuck at status=${doc.status}`).toContain(doc.status);
      }

      // The point of this whole file: whatever that input did, the process is
      // still answering afterwards. (Not /health: its worker check needs
      // machine.start()'s continuous loop, which this drain()-based harness
      // never runs, so it would read 503 unconditionally — a fixture
      // limitation, not evidence about the adversarial input.)
      const alive = await env.app.inject({ method: "GET", url: "/api/documents" });
      expect(alive.statusCode, `${c.name}: app still responsive after ingest`).toBe(200);
    });
  }
});

describe("adversarial corpus — ingest-level guards (not just the unit-level rasterizer test)", () => {
  it(
    "a 14400x14400pt MediaBox: imageLane escalates an unresolved vendor to the VLM, " +
      "rasterizePdf's pixel-budget guard throws as an ordinary caught stage error, and the " +
      "document reaches failed after retries — never the OOM docs/deployment.md warns about",
    async () => {
      // packages/server/test/unit/pdf/rasterize.test.ts already pins the guard
      // itself; this proves the PIPELINE reaches it and survives, which needs
      // vlm.enabled — off by default in loadConfig — so this test builds its
      // own env rather than using the shared per-test fixture.
      const docling = new FakeDocling();
      // Empty positioned doc: no vendor identifiers, so imageLane escalates
      // instead of applying a template or landing straight in pending_review.
      docling.enqueue(rawDoclingDocument([]));
      const env = await createTestEnv({
        docling,
        config: { pipeline: { vlm: { enabled: true } } },
      });
      try {
        const data = await makeHugeMediaBoxPdf();
        const { payload, headers } = multipartBody([{ filename: "huge.pdf", data }]);
        const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
        expect(res.statusCode).toBe(202);
        const id = (res.json() as UploadResult[])[0]!.documentId;

        await env.machine.drain();

        const doc = (await env.app.inject({ method: "GET", url: `/api/documents/${id}` })).json() as Detail;
        expect(doc.status).toBe("failed");
        expect(doc.error ?? "").toMatch(/too large|pixel budget/i);
        docling.assertDrained();
      } finally {
        await env.close();
      }
    },
  );

  it("two rival zugferd attachments: the FIRST one wins, deterministically, all the way to committed", async ({
    env,
  }) => {
    const data = await makeMultiXmlAttachmentPdf();
    const { payload, headers } = multipartBody([{ filename: "multi-xml.pdf", data }]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
    const id = (res.json() as UploadResult[])[0]!.documentId;

    await env.machine.drain();

    const doc = (await env.app.inject({ method: "GET", url: `/api/documents/${id}` })).json() as Detail;
    expect(doc.status, `violations: ${JSON.stringify(doc.violations)}`).toBe("committed");
    // Both triage (routing) and the zugferd stage (re-extraction) scan
    // attachments in the SAME order, so the winner is the one attached first —
    // "factur-x.xml" (sampleSpec()'s own "R-2026-0042") — not the rival
    // "zugferd-invoice.xml" ("RIVAL-999"). The literal below deliberately does
    // NOT import sampleSpec (packages/fixtures/test/unit/goldenPurity.test.ts
    // bans reaching for it from packages/server/test — the oracle-independence
    // guard); makeMultiXmlAttachmentPdf() is free to use it internally since
    // packages/fixtures/src/generators/ isn't in that guard's list.
    expect((doc.result as { invoiceNumber: string }).invoiceNumber).toBe("R-2026-0042");
  });

  it("a factur-x.xml attachment that is actually PNG bytes falls through instead of hard-erroring", async ({
    env,
    docling,
  }) => {
    docling.enqueue(rawDoclingDocument([]));
    const data = await makeWrongTypeAttachmentPdf();
    const { payload, headers } = multipartBody([{ filename: "wrong-type.pdf", data }]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
    const id = (res.json() as UploadResult[])[0]!.documentId;

    await env.machine.drain();

    const doc = (await env.app.inject({ method: "GET", url: `/api/documents/${id}` })).json() as Detail;
    expect(TERMINAL, `stuck at status=${doc.status}`).toContain(doc.status);
    const trace = (await env.app.inject({ method: "GET", url: `/api/documents/${id}/trace` })).json() as Trace;
    // zugferd.ts's own doc comment: "ANY parse/mapping failure degrades
    // gracefully into the text lane — a malformed hybrid must never hard-error".
    // xml_fallthrough is the event that proves that happened here.
    expect(trace.events.map((e) => e.event)).toContain("xml_fallthrough");
  });
});

describe("adversarial corpus — the queue survives it (the acceptance criterion)", () => {
  it("ingesting the WHOLE corpus in one request, then a known-good invoice, still commits", async ({
    env,
    docling,
  }) => {
    const cases = corpusCases();
    const files = await Promise.all(
      cases.map(async (c) => ({ filename: c.filename, data: await c.build() })),
    );
    const { payload, headers } = multipartBody(files);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
    const ids = (res.json() as UploadResult[]).map((r) => r.documentId);
    // Every file except the 0-byte one gets an id; that one is silently
    // dropped rather than stored (see the per-file suite above).
    expect(ids.length).toBe(cases.length - 1);

    await env.machine.drain();

    for (const id of ids) {
      const doc = (await env.app.inject({ method: "GET", url: `/api/documents/${id}` })).json() as Detail;
      expect(TERMINAL, `document ${id} stuck at status=${doc.status}`).toContain(doc.status);
    }

    // THE assertion. Nothing above may have left the worker's claim loop
    // wedged (docs/deployment.md's poison-document scenario) — proven by a fresh,
    // ordinary invoice still reaching `committed` right after the corpus.
    docling.enqueue(goldenDocling(STANDARD), `# ${STANDARD.render!.doc.headingText}`);
    const goldenBytes = await goldenPdf(STANDARD);
    const { payload: p2, headers: h2 } = multipartBody([{ filename: "known-good.pdf", data: goldenBytes }]);
    const goodRes = await env.app.inject({ method: "POST", url: "/api/ingest", payload: p2, headers: h2 });
    expect(goodRes.statusCode).toBe(202);
    const goodId = (goodRes.json() as UploadResult[])[0]!.documentId;

    await env.machine.drain();

    const goodDoc = (await env.app.inject({ method: "GET", url: `/api/documents/${goodId}` })).json() as Detail;
    expect(goodDoc.status, `violations: ${JSON.stringify(goodDoc.violations)}`).toBe("committed");
  });
});

describe("adversarial corpus — filename handling", () => {
  for (const name of adversarialFilenames()) {
    // A raw NUL byte survives busboy (it isn't a path separator) but Postgres
    // TEXT columns reject it outright, so `insertDocument`'s INSERT throws and
    // Fastify's default error handler turns that into an uncaught 500 — with
    // the raw SQL statement AND its bound parameters (filename, content hash)
    // in the body, the same internals-disclosure shape as INVEX-008. This is a
    // genuinely different defect from INVEX-008 (which was about `:id`/`?limit=`
    // params) with no id assigned for it, so it is recorded here as observed
    // fact rather than pinned with knownBug().
    const containsNul = name.includes("\u0000");

    it(`filename ${JSON.stringify(name)}: ${containsNul ? "500s (undocumented defect, see comment)" : "202, and the stored name is never interpreted as a path"}`, async ({
      env,
    }) => {
      // Content is irrelevant to this suite; only the filename is under test.
      const data = makeHeaderOnlyPdf();
      const { payload, headers } = multipartBody([{ filename: name, data }]);
      const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });

      if (containsNul) {
        expect(res.statusCode, JSON.stringify(name)).toBe(500);
      } else {
        expect(res.statusCode, JSON.stringify(name)).toBe(202);
        const stored = (res.json() as UploadResult[])[0]!.filename;
        // busboy's basename() (lib/utils/basename.js) strips everything up to
        // the last "/" OR "\" before the route ever sees the filename — so
        // nothing here can escape into a directory component.
        expect(stored.includes("/"), JSON.stringify(name)).toBe(false);
        expect(stored.includes("\\"), JSON.stringify(name)).toBe(false);
      }

      // Whatever the outcome, the app must still be answering — a 500 on one
      // request must not have poisoned the connection/process for the next.
      const alive = await env.app.inject({ method: "GET", url: "/api/documents" });
      expect(alive.statusCode, JSON.stringify(name)).toBe(200);
    });
  }
});

describe("adversarial corpus — known-bug pinning", () => {
  // Cheaply reproduces the ingest atomicity defect (INVEX-056) via the
  // `files: 50` multipart limit from http/app.ts, rather than the ~100MB
  // oversized-file trigger in component/http/ingest.test.ts: 51 tiny file
  // parts (a real forwarded-mailbox digest can easily carry that many
  // attachments) throw FilesLimitError on the 51st part, AFTER the first 50
  // have already been inserted and committed in their own transactions.
  function manyTinyFiles(n: number): { filename: string; data: Uint8Array }[] {
    return Array.from({ length: n }, (_, i) => ({
      filename: `attachment-${i}.pdf`,
      data: makeHeaderOnlyPdf(),
    }));
  }

  it(
    "[current] a files-limit failure partway through leaves the earlier parts committed, though the client " +
      "never learns their ids — the request is not transactional across files",
    async ({ env }) => {
      const files = manyTinyFiles(51);
      const { payload, headers } = multipartBody(files);
      const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
      expect(res.statusCode).toBe(413);
      // The client got a 413 and no documentId for "attachment-0.pdf" — but it
      // is in the database anyway, indistinguishable from a lost/orphaned row.
      const persisted = await findReusableByHash(env.db, sha256(files[0]!.data));
      expect(persisted).not.toBeNull();
    },
    30_000,
  );

  knownBug(
    "INVEX-056",
    "ingest is not atomic across files: when one part fails mid-request the earlier parts are already " +
      "committed and their ids are never returned to the client, so the documents are orphaned in the database",
  ).it("a mid-request failure should not silently orphan the files that already succeeded", async () => {
    const env = await createTestEnv();
    try {
      const files = manyTinyFiles(51);
      const { payload, headers } = multipartBody(files);
      const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
      // Today's error body carries no trace of the 50 documents already
      // inserted. It should — a partial-success list, or an all-or-nothing
      // rollback, either would let the caller reconcile what happened.
      expect(res.json()).toHaveProperty("ingested");
    } finally {
      await env.close();
    }
  });
});

describe("INVEX-057 — a NUL byte in a filename escapes as a 500", () => {
  // Written as an escape so the source file itself holds no control character.
  const NUL_NAME = "invoice\u0000.pdf";

  it("[current] returns 500 and leaks the failed SQL with its bound parameters", async ({ env }) => {
    const { payload, headers } = multipartBody([{ filename: NUL_NAME, data: makeHeaderOnlyPdf() }]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });

    expect(res.statusCode).toBe(500);
    // The same internals-disclosure shape as INVEX-008, reached by a different
    // route: there the id was unvalidated, here the FILENAME is. Both end in an
    // unhandled Postgres error rendered by Fastify's default handler.
    expect(res.body).toMatch(/insert into|documents/i);
  });

  knownBug("INVEX-057", "a NUL byte in an uploaded filename reaches Postgres and 500s with the SQL in the body")
    .it("rejects or sanitizes the filename instead of 500ing", async () => {
      // knownBug() wraps plain vitest `it`, which carries none of the fixture
      // harness's injected values, so this builds its own environment.
      const env = await createTestEnv();
      try {
        const { payload, headers } = multipartBody([{ filename: NUL_NAME, data: makeHeaderOnlyPdf() }]);
        const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });

        // Either outcome is fine; a 500 carrying the query is not. The intended
        // entry point is email attachments, where the filename is attacker-controlled.
        expect(res.statusCode).toBeLessThan(500);
      } finally {
        await env.close();
      }
    });
});
