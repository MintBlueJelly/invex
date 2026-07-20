import type { VlmExtractRequest, VlmExtractResult, VlmPort } from "../../ports";

/**
 * OpenAI-compatible VLM client with schema-constrained decoding (briefing §6).
 * VLM_SCHEMA_MODE picks how the schema travels:
 *  - "response_format": response_format.json_schema (vLLM, llama.cpp, OpenAI)
 *  - "ollama_format":  Ollama's native `format` field
 * Constrained decoding guarantees schema validity by construction where the
 * backend honors it; the caller still Zod-validates (that's the real gate).
 */

export interface OpenAiCompatOptions {
  baseUrl: string;
  model: string;
  schemaMode: "response_format" | "ollama_format";
  timeoutMs: number;
  apiKey?: string;
}

export function createOpenAiCompatVlm(opts: OpenAiCompatOptions): VlmPort {
  if (opts.model === "") {
    throw new Error("VLM_MODEL is not configured (briefing §11: model choice pending)");
  }

  async function call(req: VlmExtractRequest, extraSystem: string): Promise<VlmExtractResult> {
    const content: unknown[] = [
      { type: "text", text: "Extract the document per the system instructions." },
      ...req.images.map((img) => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${Buffer.from(img).toString("base64")}` },
      })),
    ];
    const body: Record<string, unknown> = {
      model: opts.model,
      temperature: 0,
      messages: [
        { role: "system", content: req.systemPrompt + extraSystem },
        { role: "user", content },
      ],
    };
    if (opts.schemaMode === "response_format") {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: "invex_result", schema: req.jsonSchema, strict: true },
      };
    } else {
      body["format"] = req.jsonSchema;
    }

    const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`VLM request failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      model?: string;
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    try {
      return { json: JSON.parse(stripFences(raw)), raw, model: data.model ?? opts.model };
    } catch {
      throw new InvalidVlmJsonError(raw);
    }
  }

  return {
    async extractStructured(req) {
      try {
        return await call(req, "");
      } catch (err) {
        // One retry with error feedback on non-JSON output.
        if (err instanceof InvalidVlmJsonError) {
          return call(
            req,
            "\n\nIMPORTANT: your previous response was not valid JSON. Respond with ONLY a single JSON object matching the schema — no prose, no code fences.",
          );
        }
        throw err;
      }
    },
  };
}

class InvalidVlmJsonError extends Error {
  constructor(public readonly raw: string) {
    super("VLM returned non-JSON output");
  }
}

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
}
