import { describe, expect, it } from "vitest";
import { closedPortUrl, startStubQueue, startStubServer } from "../utils/httpStub";

/**
 * Self-test for the loopback stub used by the docling and VLM client tests
 * (Phase 4'). The point of a real server over a MockAgent is that timeouts and
 * socket resets behave like the production path — so those two are asserted here.
 */

describe("httpStub", () => {
  it("records method, path, headers and body", async () => {
    const s = await startStubServer(() => ({ json: { ok: true } }));
    try {
      const res = await fetch(`${s.url}/v1/convert`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      expect(s.requests).toHaveLength(1);
      const [req] = s.requests;
      expect(req!.method).toBe("POST");
      expect(req!.url).toBe("/v1/convert");
      expect(req!.headers["authorization"]).toBe("Bearer secret");
      expect(JSON.parse(req!.body)).toEqual({ hello: "world" });
    } finally {
      await s.close();
    }
  });

  it("serves a queue in order and repeats the last entry", async () => {
    const s = await startStubQueue([{ status: 503, text: "loading" }, { json: { n: 2 } }]);
    try {
      expect((await fetch(s.url)).status).toBe(503);
      expect(await (await fetch(s.url)).json()).toEqual({ n: 2 });
      expect(await (await fetch(s.url)).json()).toEqual({ n: 2 });
      expect(s.requests).toHaveLength(3);
    } finally {
      await s.close();
    }
  });

  it("returns a non-JSON body verbatim, so error-path text() is exercised", async () => {
    const s = await startStubServer(() => ({ status: 500, text: "<html>proxy error</html>" }));
    try {
      const res = await fetch(s.url);
      expect(res.ok).toBe(false);
      expect(await res.text()).toBe("<html>proxy error</html>");
    } finally {
      await s.close();
    }
  });

  it("a delayed response is genuinely aborted by AbortSignal.timeout", async () => {
    const s = await startStubServer(() => ({ delayMs: 2_000, json: {} }));
    try {
      const started = Date.now();
      await expect(fetch(s.url, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
      // Proves the abort really fired rather than the request completing.
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await s.close();
    }
  });

  it("hangUp destroys the socket, producing a real network error", async () => {
    const s = await startStubServer(() => ({ hangUp: true }));
    try {
      await expect(fetch(s.url)).rejects.toThrow();
    } finally {
      await s.close();
    }
  });

  it("closedPortUrl refuses connections", async () => {
    const url = await closedPortUrl();
    await expect(fetch(url)).rejects.toThrow();
  });
});
