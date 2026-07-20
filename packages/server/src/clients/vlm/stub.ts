import type { VlmResult } from "@invex/core";
import type { VlmExtractRequest, VlmExtractResult, VlmPort } from "../../ports";

/**
 * Deterministic VLM stub: tests (and VLM-less deployments during evaluation)
 * inject the result the "model" should produce. A queue mirrors FakeDocling;
 * a fallback handler covers ad-hoc cases.
 */
export class StubVlm implements VlmPort {
  private queue: VlmResult[] = [];

  constructor(private fallback?: (req: VlmExtractRequest) => VlmResult) {}

  enqueue(result: VlmResult): void {
    this.queue.push(result);
  }

  extractStructured(req: VlmExtractRequest): Promise<VlmExtractResult> {
    const result = this.queue.shift() ?? this.fallback?.(req);
    if (!result) return Promise.reject(new Error("StubVlm has no queued result"));
    return Promise.resolve({ json: result, raw: JSON.stringify(result), model: "stub" });
  }
}
