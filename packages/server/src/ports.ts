/**
 * Ports to external services. Pipeline stages depend on these interfaces only,
 * so tests run the real worker loop against fakes (FakeDoclingPort, StubVlm).
 */

export interface DoclingConvertResult {
  /** Raw DoclingDocument JSON (mapped to PositionedTextDocument in core). */
  doclingJson: unknown;
  markdown: string;
}

export interface DoclingPort {
  convert(
    pdf: Uint8Array,
    opts: { ocr: boolean; tables: boolean },
  ): Promise<DoclingConvertResult>;
}

export interface VlmExtractRequest {
  images: Uint8Array[];
  jsonSchema: Record<string, unknown>;
  systemPrompt: string;
}

export interface VlmExtractResult {
  json: unknown;
  raw: string;
  model: string;
}

export interface VlmPort {
  extractStructured(req: VlmExtractRequest): Promise<VlmExtractResult>;
}
