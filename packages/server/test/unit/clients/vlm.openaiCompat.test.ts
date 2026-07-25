import { describe, expect, it } from "vitest";
import { createOpenAiCompatVlm, type OpenAiCompatOptions } from "../../../src/clients/vlm/openaiCompat";
import { closedPortUrl, startStubQueue, startStubServer } from "../../utils/httpStub";
import { knownBug } from "../../../../../test-utils/knownBug";

/**
 * LiteLLM-fronted vLLM/llama-swap (docs/deployment.md): a cold model load takes
 * 1.5-2.5 minutes and a 503 mid-swap is called out as routine. These cover the
 * wire contract (schema modes, image framing, auth) and the failure shapes
 * that reach this client in that deployment.
 */

const SCHEMA = { type: "object", properties: { total: { type: "number" } }, required: ["total"] };

function opts(over: Partial<OpenAiCompatOptions> = {}): OpenAiCompatOptions {
  return { baseUrl: "http://unused", model: "vlm-model", schemaMode: "response_format", timeoutMs: 5_000, ...over };
}

function req(images: Uint8Array[] = [new Uint8Array([1, 2, 3])]) {
  return { images, jsonSchema: SCHEMA, systemPrompt: "Extract the invoice fields." };
}

function reply(content: string, extra: Record<string, unknown> = {}) {
  return { json: { choices: [{ message: { content } }], model: "served-model", ...extra } };
}

describe("createOpenAiCompatVlm — constructor", () => {
  it("rejects an empty model at construction, before any request is made", () => {
    expect(() => createOpenAiCompatVlm(opts({ model: "" }))).toThrow(/VLM_MODEL/);
  });
});

describe("createOpenAiCompatVlm — schema modes", () => {
  it("response_format mode nests the schema under response_format.json_schema", async () => {
    const s = await startStubServer(() => reply('{"total":1}'));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url, schemaMode: "response_format" }));
      await vlm.extractStructured(req());
      const body = JSON.parse(s.requests[0]!.body);
      expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "invex_result", schema: SCHEMA, strict: true } });
      expect(body.format).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it("ollama_format mode sends the schema as body.format, not response_format", async () => {
    const s = await startStubServer(() => reply('{"total":1}'));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url, schemaMode: "ollama_format" }));
      await vlm.extractStructured(req());
      const body = JSON.parse(s.requests[0]!.body);
      expect(body.format).toEqual(SCHEMA);
      expect(body.response_format).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});

describe("createOpenAiCompatVlm — request shape", () => {
  it("emits exactly one image_url content part per page, in order", async () => {
    const pages = [new Uint8Array([10, 20]), new Uint8Array([30, 40]), new Uint8Array([50, 60])];
    const s = await startStubServer(() => reply('{"total":1}'));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      await vlm.extractStructured(req(pages));
      const body = JSON.parse(s.requests[0]!.body);
      const userContent = body.messages[1].content as { type: string; image_url?: { url: string } }[];
      const imageParts = userContent.filter((p) => p.type === "image_url");
      expect(imageParts).toHaveLength(pages.length);
      imageParts.forEach((part, i) => {
        const b64 = part.image_url!.url.replace(/^data:image\/png;base64,/, "");
        expect(Uint8Array.from(Buffer.from(b64, "base64"))).toEqual(pages[i]);
      });
    } finally {
      await s.close();
    }
  });

  it("sends the authorization header only when an apiKey is configured", async () => {
    const withKey = await startStubServer(() => reply('{"total":1}'));
    const withoutKey = await startStubServer(() => reply('{"total":1}'));
    try {
      await createOpenAiCompatVlm(opts({ baseUrl: withKey.url, apiKey: "secret-token" })).extractStructured(req());
      expect(withKey.requests[0]!.headers["authorization"]).toBe("Bearer secret-token");

      await createOpenAiCompatVlm(opts({ baseUrl: withoutKey.url })).extractStructured(req());
      expect(withoutKey.requests[0]!.headers["authorization"]).toBeUndefined();
    } finally {
      await withKey.close();
      await withoutKey.close();
    }
  });

  it("puts the caller's system prompt in the system message on the first attempt", async () => {
    const s = await startStubServer(() => reply('{"total":1}'));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      await vlm.extractStructured(req());
      const body = JSON.parse(s.requests[0]!.body);
      expect(body.messages[0]).toEqual({ role: "system", content: "Extract the invoice fields." });
    } finally {
      await s.close();
    }
  });
});

describe("createOpenAiCompatVlm — fence stripping (clean case) and reported model", () => {
  it("parses a clean ```json fenced block on the first attempt", async () => {
    const s = await startStubServer(() => reply('```json\n{"total":42}\n```'));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      const result = await vlm.extractStructured(req());
      expect(result.json).toEqual({ total: 42 });
      expect(s.requests).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it("reports data.model when the server includes one (LiteLLM may rewrite the alias)", async () => {
    const s = await startStubServer(() => reply('{"total":1}', { model: "actual-served-model" }));
    try {
      const result = await createOpenAiCompatVlm(opts({ baseUrl: s.url, model: "alias" })).extractStructured(req());
      expect(result.model).toBe("actual-served-model");
    } finally {
      await s.close();
    }
  });

  it("falls back to the configured model when the response omits one", async () => {
    const s = await startStubServer(() => ({ json: { choices: [{ message: { content: '{"total":1}' } }] } }));
    try {
      const result = await createOpenAiCompatVlm(opts({ baseUrl: s.url, model: "configured-model" })).extractStructured(req());
      expect(result.model).toBe("configured-model");
    } finally {
      await s.close();
    }
  });
});

describe("createOpenAiCompatVlm — one-shot retry on invalid JSON", () => {
  it("retries once with corrective feedback, and does not recurse on a second failure", async () => {
    const s = await startStubQueue([reply("not json at all"), reply('{"total":7}')]);
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      const result = await vlm.extractStructured(req());
      expect(result.json).toEqual({ total: 7 });
      expect(s.requests).toHaveLength(2);
      const secondSystem = JSON.parse(s.requests[1]!.body).messages[0].content;
      expect(secondSystem).toMatch(/not valid JSON/i);
    } finally {
      await s.close();
    }
  });

  it("gives up after the retry also fails — exactly 2 requests, no further recursion", async () => {
    const s = await startStubServer(() => reply("still not json"));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      await expect(vlm.extractStructured(req())).rejects.toThrow(/non-JSON/);
      expect(s.requests).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it("empty choices (raw content defaults to \"\") is treated as invalid JSON and triggers the retry", async () => {
    const s = await startStubServer(() => ({ json: { choices: [] } }));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      await expect(vlm.extractStructured(req())).rejects.toThrow(/non-JSON/);
      expect(s.requests).toHaveLength(2);
    } finally {
      await s.close();
    }
  });
});

describe("createOpenAiCompatVlm — network behaviour", () => {
  it("AbortSignal.timeout aborts a slow response during a model swap instead of hanging", async () => {
    const s = await startStubServer(() => ({ delayMs: 300, ...reply('{"total":1}') }));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url, timeoutMs: 50 }));
      const started = Date.now();
      await expect(vlm.extractStructured(req())).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await s.close();
    }
  });

  it("rejects with a connection error when the endpoint is unreachable", async () => {
    const url = await closedPortUrl();
    const vlm = createOpenAiCompatVlm(opts({ baseUrl: url }));
    await expect(vlm.extractStructured(req())).rejects.toThrow();
  });
});

describe("createOpenAiCompatVlm — INVEX-048 (503 during a model swap is not retried)", () => {
  it("[current] a 503 while llama-swap is mid-swap throws immediately, unlike invalid JSON", async () => {
    const s = await startStubQueue([{ status: 503, text: "loading model" }, reply('{"total":1}')]);
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      await expect(vlm.extractStructured(req())).rejects.toThrow(/503/);
      expect(s.requests).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  knownBug(
    "INVEX-048",
    "openaiCompat retries only on unparseable JSON — a 503 mid model-swap (docs/deployment.md calls this routine) costs the attempt",
  ).it("retries a 503 the same way it retries invalid JSON", async () => {
    const s = await startStubQueue([{ status: 503, text: "loading model" }, reply('{"total":1}')]);
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      const result = await vlm.extractStructured(req());
      expect(result.json).toEqual({ total: 1 });
      expect(s.requests.length).toBeGreaterThan(1);
    } finally {
      await s.close();
    }
  });
});

describe("createOpenAiCompatVlm — INVEX-049 (finish_reason and refusal ignored)", () => {
  it("[current] a token-limit truncation (finish_reason: length) is reported as generic non-JSON output", async () => {
    // Truncated mid-object: invalid JSON, and indistinguishable from a bad model
    // since finish_reason is never read.
    const s = await startStubServer(() => ({
      json: { choices: [{ message: { content: '{"total": 1, "vendor": "Acme Corp' }, finish_reason: "length" }] },
    }));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      const err = await vlm.extractStructured(req()).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/non-JSON/);
      // The generic message says nothing about truncation/capacity — a capacity
      // problem reads identically to a bad model.
      expect((err as Error).message).not.toMatch(/length|truncat|token/i);
    } finally {
      await s.close();
    }
  });

  knownBug(
    "INVEX-049",
    "finish_reason is never inspected, so a token-limit truncation is indistinguishable from a bad model",
  ).it("surfaces a token-limit truncation distinctly from ordinary non-JSON output", async () => {
    const s = await startStubServer(() => ({
      json: { choices: [{ message: { content: '{"total": 1, "vendor": "Acme Corp' }, finish_reason: "length" }] },
    }));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      await expect(vlm.extractStructured(req())).rejects.toThrow(/length|truncat|max.?tokens/i);
    } finally {
      await s.close();
    }
  });

  it("[current] a model refusal (message.refusal set, no content) surfaces as generic non-JSON output", async () => {
    const s = await startStubServer(() => ({
      json: { choices: [{ message: { refusal: "I cannot process this image" } }] },
    }));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      await expect(vlm.extractStructured(req())).rejects.toThrow(/non-JSON/);
    } finally {
      await s.close();
    }
  });

  knownBug("INVEX-049", "refusal is never inspected, so the model's stated reason is discarded").it(
    "surfaces the model's refusal text instead of a generic non-JSON error",
    async () => {
      const s = await startStubServer(() => ({
        json: { choices: [{ message: { refusal: "I cannot process this image" } }] },
      }));
      try {
        const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
        await expect(vlm.extractStructured(req())).rejects.toThrow(/cannot process this image/);
      } finally {
        await s.close();
      }
    },
  );
});

describe("createOpenAiCompatVlm — INVEX-050 (stripFences only removes one leading/trailing fence)", () => {
  it("[current] prose before the fenced JSON defeats stripping, forcing a retry that fails identically", async () => {
    const content = 'Sure, here is the result:\n```json\n{"total":1}\n```';
    const s = await startStubServer(() => reply(content));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      await expect(vlm.extractStructured(req())).rejects.toThrow(/non-JSON/);
      expect(s.requests).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  knownBug(
    "INVEX-050",
    "stripFences only removes one leading/trailing fence — prose before the JSON defeats it with no brace-matching fallback",
  ).it("extracts the JSON on the first attempt despite prose before the fenced block", async () => {
    const content = 'Sure, here is the result:\n```json\n{"total":1}\n```';
    const s = await startStubServer(() => reply(content));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      const result = await vlm.extractStructured(req());
      expect(result.json).toEqual({ total: 1 });
      expect(s.requests).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it("[current] a <think> block (reasoning VLM) before the fenced JSON likewise defeats stripping", async () => {
    const content = '<think>Let me check the totals.</think>\n```json\n{"total":1}\n```';
    const s = await startStubServer(() => reply(content));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      await expect(vlm.extractStructured(req())).rejects.toThrow(/non-JSON/);
      expect(s.requests).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  knownBug(
    "INVEX-050",
    "a <think> reasoning block before the fenced JSON is very likely from a reasoning VLM and defeats stripFences",
  ).it("extracts the JSON on the first attempt despite a leading <think> block", async () => {
    const content = '<think>Let me check the totals.</think>\n```json\n{"total":1}\n```';
    const s = await startStubServer(() => reply(content));
    try {
      const vlm = createOpenAiCompatVlm(opts({ baseUrl: s.url }));
      const result = await vlm.extractStructured(req());
      expect(result.json).toEqual({ total: 1 });
      expect(s.requests).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
});
