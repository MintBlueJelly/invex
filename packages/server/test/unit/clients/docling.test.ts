import { describe, expect, it } from "vitest";
import { createDoclingClient } from "../../../src/clients/docling";
import { closedPortUrl, startStubQueue, startStubServer } from "../../utils/httpStub";
import { knownBug } from "../../../../../test-utils/knownBug";

/**
 * docling-serve is the most failure-prone dependency per DEPLOYMENT.md (single
 * StatefulSet replica, no route redundancy) — these cover the wire contract and
 * the failure shapes an operator actually hits: restarts, a proxy's non-JSON
 * error page, and a slow response during a busy OCR/TableFormer pass.
 */

// Deliberately not printable ASCII throughout — proves the base64 round-trip
// isn't silently relying on text-safe bytes.
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0x01, 0x02, 0xfe, 0xff, 0x80, 0x7f]);

const GOOD_DOCUMENT = { document: { json_content: { pages: [{ text: "hi" }] }, md_content: "# Title" } };

describe("createDoclingClient — request shape", () => {
  it("round-trips the PDF bytes through base64 byte-for-byte", async () => {
    const s = await startStubServer(() => ({ json: GOOD_DOCUMENT }));
    try {
      const client = createDoclingClient(s.url);
      await client.convert(PDF_BYTES, { ocr: false, tables: false });
      const body = JSON.parse(s.requests[0]!.body);
      const decoded = Buffer.from(body.sources[0].base64_string, "base64");
      expect(Uint8Array.from(decoded)).toEqual(PDF_BYTES);
      expect(body.sources[0].kind).toBe("file");
    } finally {
      await s.close();
    }
  });

  it("sends ocr/tables options as do_ocr / do_table_structure", async () => {
    const s = await startStubServer(() => ({ json: GOOD_DOCUMENT }));
    try {
      const client = createDoclingClient(s.url);
      await client.convert(PDF_BYTES, { ocr: true, tables: false });
      const body = JSON.parse(s.requests[0]!.body);
      expect(body.options.do_ocr).toBe(true);
      expect(body.options.do_table_structure).toBe(false);
    } finally {
      await s.close();
    }
  });
});

describe("createDoclingClient — success path", () => {
  it("returns doclingJson and markdown from a 200 response", async () => {
    const s = await startStubServer(() => ({ json: GOOD_DOCUMENT }));
    try {
      const client = createDoclingClient(s.url);
      const result = await client.convert(PDF_BYTES, { ocr: false, tables: false });
      expect(result.doclingJson).toEqual(GOOD_DOCUMENT.document.json_content);
      expect(result.markdown).toBe("# Title");
    } finally {
      await s.close();
    }
  });

  it("markdown falls back to empty string when md_content is null", async () => {
    const s = await startStubServer(() => ({ json: { document: { json_content: { ok: true }, md_content: null } } }));
    try {
      const client = createDoclingClient(s.url);
      const result = await client.convert(PDF_BYTES, { ocr: false, tables: false });
      expect(result.markdown).toBe("");
    } finally {
      await s.close();
    }
  });
});

describe("createDoclingClient — error responses", () => {
  it.each([500, 503, 413])("a %d response throws carrying status and body text", async (status) => {
    const bodyText = `docling-serve error ${status}`;
    const s = await startStubServer(() => ({ status, text: bodyText }));
    try {
      const client = createDoclingClient(s.url);
      await expect(client.convert(PDF_BYTES, { ocr: false, tables: false })).rejects.toThrow(
        new RegExp(`${status}.*${bodyText}`),
      );
    } finally {
      await s.close();
    }
  });

  it("throws when document.json_content is missing", async () => {
    const s = await startStubServer(() => ({ json: { document: { md_content: "x" } } }));
    try {
      const client = createDoclingClient(s.url);
      await expect(client.convert(PDF_BYTES, { ocr: false, tables: false })).rejects.toThrow(/json_content/);
    } finally {
      await s.close();
    }
  });
});

describe("createDoclingClient — network behaviour", () => {
  it("AbortSignal.timeout aborts a slow response instead of hanging on a busy OCR pass", async () => {
    const s = await startStubServer(() => ({ delayMs: 300, json: GOOD_DOCUMENT }));
    try {
      const client = createDoclingClient(s.url, 50);
      const started = Date.now();
      await expect(client.convert(PDF_BYTES, { ocr: false, tables: false })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await s.close();
    }
  });

  it("rejects with a connection error when docling-serve is unreachable", async () => {
    const url = await closedPortUrl();
    const client = createDoclingClient(url);
    await expect(client.convert(PDF_BYTES, { ocr: false, tables: false })).rejects.toThrow();
  });
});

describe("createDoclingClient — INVEX-051 (no retries, no response validation)", () => {
  it("[current] a transient 503 (e.g. docling-serve restarting) is not retried — the document loses its one attempt", async () => {
    const s = await startStubQueue([{ status: 503, text: "loading" }, { json: GOOD_DOCUMENT }]);
    try {
      const client = createDoclingClient(s.url);
      await expect(client.convert(PDF_BYTES, { ocr: false, tables: false })).rejects.toThrow(/503/);
      expect(s.requests).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  knownBug(
    "INVEX-051",
    "docling.ts has no retries despite being the most failure-prone dependency (DEPLOYMENT.md)",
  ).it("retries a transient 503 instead of failing the document on the first restart blip", async () => {
    const s = await startStubQueue([{ status: 503, text: "loading" }, { json: GOOD_DOCUMENT }]);
    try {
      const client = createDoclingClient(s.url);
      const result = await client.convert(PDF_BYTES, { ocr: false, tables: false });
      expect(result.doclingJson).toEqual(GOOD_DOCUMENT.document.json_content);
      expect(s.requests.length).toBeGreaterThan(1);
    } finally {
      await s.close();
    }
  });

  it("[current] a non-JSON 200 body (e.g. an HTML proxy error page) surfaces as a bare SyntaxError with no request context", async () => {
    const s = await startStubServer(() => ({ status: 200, text: "<html>gateway timeout</html>" }));
    try {
      const client = createDoclingClient(s.url);
      let caught: unknown;
      try {
        await client.convert(PDF_BYTES, { ocr: false, tables: false });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SyntaxError);
      // No mention of "docling" or the URL/status — nothing to grep for in the logs.
      expect(String((caught as Error).message)).not.toMatch(/docling/i);
    } finally {
      await s.close();
    }
  });

  knownBug(
    "INVEX-051",
    "a non-JSON 200 body (proxy error page) should be reported with request context, not a bare SyntaxError",
  ).it("reports a non-JSON 200 body with context identifying it as a docling response", async () => {
    const s = await startStubServer(() => ({ status: 200, text: "<html>gateway timeout</html>" }));
    try {
      const client = createDoclingClient(s.url);
      await expect(client.convert(PDF_BYTES, { ocr: false, tables: false })).rejects.toThrow(/docling/i);
    } finally {
      await s.close();
    }
  });
});
