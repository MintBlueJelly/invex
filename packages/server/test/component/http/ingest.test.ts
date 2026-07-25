import { createHash } from "node:crypto";
import { goldenPdf, loadGolden } from "@invex/fixtures";
import { describe, expect, makeItShared } from "../../utils/fixture";
import { createTestEnv, multipartBody } from "../../utils/testEnv";
import { findReusableByHash } from "../../../src/db/repos/documents";
import { UUID_RE } from "../../../src/http/params";
import { knownBug } from "../../../../../test-utils/knownBug";

/**
 * POST /api/ingest is the entry point for email attachments — arbitrary bytes
 * from the internet, one request per email, up to 50 file parts each up to
 * 100MB (see the multipart registration in http/app.ts).
 */

const it = makeItShared();

const STANDARD = loadGolden("de-standard-19");
const MULTIPAGE = loadGolden("de-multipage-3");
const NON_INVOICE = loadGolden("non-invoice-letter");

type UploadResult = { documentId: string; filename: string; deduplicated: boolean };

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * multipartBody() in testEnv.ts hardcodes field name "file" and
 * Content-Type "application/pdf" — several cases below need to vary those
 * (or omit filename) to see what ingest actually checks.
 */
function customMultipart(
  parts: { name?: string; filename?: string; contentType?: string; data: Uint8Array }[],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----invex-ingest-test-boundary-91a2";
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const name = p.name ?? "file";
    const filenameAttr = p.filename === undefined ? "" : `; filename="${p.filename}"`;
    const contentType = p.contentType ?? "application/octet-stream";
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"${filenameAttr}\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.from(p.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe("POST /api/ingest — happy path", () => {
  it("a single valid PDF returns 202 with documentId/filename/deduplicated:false", async ({ env }) => {
    const pdf = await goldenPdf(STANDARD);
    const { payload, headers } = multipartBody([{ filename: "invoice.pdf", data: pdf }]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
    const body = res.json() as UploadResult[];
    expect(body).toHaveLength(1);
    expect(body[0]!.filename).toBe("invoice.pdf");
    expect(body[0]!.deduplicated).toBe(false);
    expect(body[0]!.documentId).toMatch(UUID_RE);
  });

  it("several files in one request produce one entry each, in part order", async ({ env }) => {
    const [a, b, c] = await Promise.all([goldenPdf(STANDARD), goldenPdf(MULTIPAGE), goldenPdf(NON_INVOICE)]);
    const { payload, headers } = multipartBody([
      { filename: "a.pdf", data: a! },
      { filename: "b.pdf", data: b! },
      { filename: "c.pdf", data: c! },
    ]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
    const body = res.json() as UploadResult[];
    expect(body.map((r) => r.filename)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(new Set(body.map((r) => r.documentId)).size).toBe(3);
  });
});

describe("POST /api/ingest — no usable file parts", () => {
  it("400s when the multipart request carries no parts at all", async ({ env }) => {
    const { payload, headers } = multipartBody([]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(400);
  });

  it("400s when the only part is a form FIELD, not a file", async ({ env }) => {
    // busboy classifies a part as a file when it has a `filename` attribute
    // OR a Content-Type of application/octet-stream — so this needs BOTH
    // absent to land as type "field", which the route's `part.type !== "file"`
    // guard then skips entirely.
    const { payload, headers } = customMultipart([
      { name: "note", filename: undefined, contentType: "text/plain", data: Buffer.from("hi") },
    ]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(400);
  });

  it("406s on a non-multipart request body", async ({ env }) => {
    const res = await env.app.inject({
      method: "POST",
      url: "/api/ingest",
      payload: JSON.stringify({ foo: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(406);
  });
});

describe("POST /api/ingest — dedup", () => {
  it("re-ingesting identical bytes returns deduplicated:true with the SAME documentId", async ({ env }) => {
    const pdf = await goldenPdf(STANDARD);
    const first = multipartBody([{ filename: "invoice.pdf", data: pdf }]);
    const r1 = await env.app.inject({ method: "POST", url: "/api/ingest", ...first });
    const firstBody = r1.json() as UploadResult[];
    expect(firstBody[0]!.deduplicated).toBe(false);

    const second = multipartBody([{ filename: "invoice-resend.pdf", data: pdf }]);
    const r2 = await env.app.inject({ method: "POST", url: "/api/ingest", ...second });
    const secondBody = r2.json() as UploadResult[];
    expect(r2.statusCode).toBe(202);
    expect(secondBody[0]!.deduplicated).toBe(true);
    expect(secondBody[0]!.documentId).toBe(firstBody[0]!.documentId);
    // The response filename tracks the CURRENT request's part, not the
    // originally stored one — worth knowing when correlating logs to inbox.
    expect(secondBody[0]!.filename).toBe("invoice-resend.pdf");
  });

  it("two different PDFs produce two different ids, neither deduplicated", async ({ env }) => {
    const [a, b] = await Promise.all([goldenPdf(STANDARD), goldenPdf(MULTIPAGE)]);
    const ra = await env.app.inject({
      method: "POST",
      url: "/api/ingest",
      ...multipartBody([{ filename: "a.pdf", data: a! }]),
    });
    const rb = await env.app.inject({
      method: "POST",
      url: "/api/ingest",
      ...multipartBody([{ filename: "b.pdf", data: b! }]),
    });
    const [ba, bb] = [ra.json() as UploadResult[], rb.json() as UploadResult[]];
    expect(ba[0]!.deduplicated).toBe(false);
    expect(bb[0]!.deduplicated).toBe(false);
    expect(ba[0]!.documentId).not.toBe(bb[0]!.documentId);
  });
});

describe("POST /api/ingest — filename handling", () => {
  it('a file part with no filename value falls back to "upload.pdf"', async ({ env }) => {
    const pdf = await goldenPdf(STANDARD);
    // filename="" (empty but present) still makes busboy classify this as a file part.
    const { payload, headers } = customMultipart([{ filename: "", contentType: "application/pdf", data: pdf }]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
    expect((res.json() as UploadResult[])[0]!.filename).toBe("upload.pdf");
  });

  it("stores and echoes a unicode filename verbatim", async ({ env }) => {
    const pdf = await goldenPdf(MULTIPAGE);
    const weird = "Rechnung_Übersicht_日本語_#7 (Kopie).pdf";
    const { payload, headers } = customMultipart([{ filename: weird, contentType: "application/pdf", data: pdf }]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
    expect((res.json() as UploadResult[])[0]!.filename).toBe(weird);
  });

  it("[current] a path-traversal-looking filename is NOT stored verbatim — busboy's basename() strips the directory part before the route ever sees it", async ({
    env,
  }) => {
    const pdf = await goldenPdf(STANDARD);
    const traversal = "../../etc/passwd.pdf";
    const { payload, headers } = customMultipart([
      { filename: traversal, contentType: "application/pdf", data: pdf },
    ]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
    expect((res.json() as UploadResult[])[0]!.filename).toBe("passwd.pdf");
  });
});

describe("POST /api/ingest — empty file parts", () => {
  it("skips a 0-byte file part silently, keeping the surrounding parts in order", async ({ env }) => {
    const [a, b] = await Promise.all([goldenPdf(STANDARD), goldenPdf(MULTIPAGE)]);
    const { payload, headers } = customMultipart([
      { filename: "a.pdf", contentType: "application/pdf", data: a! },
      { filename: "empty.pdf", contentType: "application/pdf", data: new Uint8Array(0) },
      { filename: "b.pdf", contentType: "application/pdf", data: b! },
    ]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
    expect((res.json() as UploadResult[]).map((r) => r.filename)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("400s when the only file part is 0 bytes", async ({ env }) => {
    const { payload, headers } = customMultipart([{ filename: "empty.pdf", data: new Uint8Array(0) }]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/ingest — no content validation (INVEX-055)", () => {
  it("[current] bytes with no PDF magic number are accepted as if they were a PDF", async ({ env }) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const { payload, headers } = customMultipart([{ filename: "photo.png", contentType: "image/png", data: png }]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
    expect((res.json() as UploadResult[])[0]!.deduplicated).toBe(false);
  });

  it("[current] plain text with a lying Content-Type of application/pdf is accepted too", async ({ env }) => {
    const text = Buffer.from("Dear Sir or Madam, please find nothing attached.\n");
    const { payload, headers } = customMultipart([
      { filename: "note.txt", contentType: "application/pdf", data: text },
    ]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
  });

  it("[current] the multipart field name is not checked — any field name is treated as a file", async ({ env }) => {
    const pdf = await goldenPdf(STANDARD);
    const { payload, headers } = customMultipart([
      { name: "attachment", filename: "invoice.pdf", contentType: "application/pdf", data: pdf },
    ]);
    const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
    expect(res.statusCode).toBe(202);
  });

  knownBug(
    "INVEX-055",
    "ingest accepts any bytes as a PDF: no magic-number check, no media-type validation, field name unchecked",
  ).it("non-PDF bytes should be rejected rather than stored as a document", async () => {
    // knownBug() wraps plain vitest it/it.fails, which does not carry the
    // makeItShared() fixtures — so this pin builds its own throwaway env
    // rather than destructuring {env} from the test callback.
    const env = await createTestEnv();
    try {
      const notAPdf = Buffer.from("Dear Sir or Madam, please find nothing attached.\n");
      const { payload, headers } = customMultipart([
        { filename: "note.txt", contentType: "text/plain", data: notAPdf },
      ]);
      const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await env.close();
    }
  });
});

describe("POST /api/ingest — atomicity across files in one request", () => {
  it(
    "[current] a failure partway through the loop leaves earlier files already committed, though the client " +
      "never learns their ids — the request is not transactional across files",
    async ({ env }) => {
      const first = await goldenPdf(STANDARD);
      // Exceeds the 100MB per-file limit registered in http/app.ts, so
      // part.toBuffer() throws RequestFileTooLargeError partway through the
      // SECOND part, after the first file's own transaction already committed.
      const oversized = new Uint8Array(100 * 1024 * 1024 + 16);
      const { payload, headers } = customMultipart([
        { filename: "first.pdf", contentType: "application/pdf", data: first },
        { filename: "oversized.pdf", contentType: "application/pdf", data: oversized },
      ]);
      const res = await env.app.inject({ method: "POST", url: "/api/ingest", payload, headers });
      expect(res.statusCode).toBe(413);
      // The client got a 413 and no documentId for "first.pdf" — but it is in
      // the database anyway, indistinguishable from a lost/orphaned document.
      const persisted = await findReusableByHash(env.db, sha256(first));
      expect(persisted).not.toBeNull();
    },
    30_000,
  );
});
