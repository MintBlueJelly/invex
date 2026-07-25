import type { VlmResult } from "@invex/core";
import type { DocumentRow, Tx } from "../../src/db/repos/documents";
import type { StageHandler, StagePorts } from "../../src/pipeline/machine";
import type {
  DoclingConvertResult,
  DoclingPort,
  VlmExtractRequest,
  VlmExtractResult,
  VlmPort,
} from "../../src/ports";

/**
 * Test doubles for the external ports and for stage handlers.
 *
 * Every queue-backed double records its calls and can assert it was drained.
 * That last part matters: without it an unconsumed enqueue() silently passes, so
 * a test that never actually reached the docling call still looks green.
 */

export class UnusedPortError extends Error {}

// ── docling ──────────────────────────────────────────────────────────────────

export interface DoclingCall {
  pdfBytes: number;
  ocr: boolean;
  tables: boolean;
}

export class FakeDocling implements DoclingPort {
  private queue: (DoclingConvertResult | { error: Error })[] = [];
  readonly calls: DoclingCall[] = [];

  enqueue(doclingJson: unknown, markdown = ""): this {
    this.queue.push({ doclingJson, markdown });
    return this;
  }

  enqueueError(error: Error): this {
    this.queue.push({ error });
    return this;
  }

  convert(pdf: Uint8Array, opts: { ocr: boolean; tables: boolean }): Promise<DoclingConvertResult> {
    this.calls.push({ pdfBytes: pdf.byteLength, ocr: opts.ocr, tables: opts.tables });
    const next = this.queue.shift();
    if (!next) return Promise.reject(new Error("FakeDocling queue is empty"));
    if ("error" in next) return Promise.reject(next.error);
    return Promise.resolve(next);
  }

  get pending(): number {
    return this.queue.length;
  }

  assertDrained(): void {
    if (this.queue.length > 0) {
      throw new Error(
        `FakeDocling still has ${this.queue.length} unconsumed response(s) — ` +
          `the test enqueued work the pipeline never asked for`,
      );
    }
  }
}

export const unusedDocling: DoclingPort = {
  convert() {
    return Promise.reject(new UnusedPortError("docling not expected in this test"));
  },
};

// ── VLM ──────────────────────────────────────────────────────────────────────

export interface VlmCall {
  imageCount: number;
  imageBytes: number[];
  systemPrompt: string;
  jsonSchema: Record<string, unknown>;
}

/**
 * Like src/clients/vlm/stub.ts, but records calls, can return raw (malformed,
 * fenced, prose-wrapped) output, and can fail. Kept test-side deliberately —
 * StubVlm lives in src/ and therefore ships in the production image.
 */
export class RecordingVlm implements VlmPort {
  private queue: ({ json: VlmResult } | { raw: string } | { error: Error })[] = [];
  readonly calls: VlmCall[] = [];

  constructor(private fallback?: (req: VlmExtractRequest) => VlmResult) {}

  enqueue(result: VlmResult): this {
    this.queue.push({ json: result });
    return this;
  }

  /** Raw model output, for the fence-stripping and malformed-JSON paths. */
  enqueueRaw(raw: string): this {
    this.queue.push({ raw });
    return this;
  }

  enqueueError(error: Error): this {
    this.queue.push({ error });
    return this;
  }

  extractStructured(req: VlmExtractRequest): Promise<VlmExtractResult> {
    this.calls.push({
      imageCount: req.images.length,
      imageBytes: req.images.map((i) => i.byteLength),
      systemPrompt: req.systemPrompt,
      jsonSchema: req.jsonSchema,
    });
    const next = this.queue.shift();
    if (next && "error" in next) return Promise.reject(next.error);
    if (next && "raw" in next) {
      return Promise.resolve({ json: JSON.parse(next.raw) as unknown, raw: next.raw, model: "stub" });
    }
    const result = next?.json ?? this.fallback?.(req);
    if (!result) return Promise.reject(new Error("RecordingVlm has no queued result"));
    return Promise.resolve({ json: result, raw: JSON.stringify(result), model: "stub" });
  }

  get pending(): number {
    return this.queue.length;
  }

  assertDrained(): void {
    if (this.queue.length > 0) {
      throw new Error(`RecordingVlm still has ${this.queue.length} unconsumed result(s)`);
    }
  }
}

export const unusedVlm: VlmPort = {
  extractStructured() {
    return Promise.reject(new UnusedPortError("vlm not expected in this test"));
  },
};

// ── stage handlers ───────────────────────────────────────────────────────────

export interface CountingStage {
  (tx: Tx, doc: DocumentRow, ports: StagePorts): Promise<void>;
  calls: number;
}

/** Wraps a handler that also receives its own 1-based invocation count. */
function counting(
  fn: (n: number, tx: Tx, doc: DocumentRow, ports: StagePorts) => Promise<void>,
): CountingStage {
  const wrapped = (async (tx, doc, ports) => {
    wrapped.calls += 1;
    await fn(wrapped.calls, tx, doc, ports);
  }) as CountingStage;
  wrapped.calls = 0;
  return wrapped;
}

/** Throws on the first `n` invocations, then delegates. Drives the retry machinery. */
export function flakyStage(n: number, inner?: StageHandler): CountingStage {
  return counting(async (call, tx, doc, ports) => {
    if (call <= n) throw new Error(`flaky stage failure #${call}`);
    await inner?.(tx, doc, ports);
  });
}

/** Always throws the given value (pass a non-Error to test string coercion). */
export function crashingStage(err: unknown): CountingStage {
  return counting(() => Promise.reject(err));
}

/** Resolves after `ms`. Drives stop()/shutdown tests. */
export function slowStage(ms: number, inner?: StageHandler): CountingStage {
  return counting(async (_call, tx, doc, ports) => {
    await new Promise((r) => setTimeout(r, ms));
    await inner?.(tx, doc, ports);
  });
}
