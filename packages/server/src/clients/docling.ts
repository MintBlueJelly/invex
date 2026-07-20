import type { DoclingPort } from "../ports";

/**
 * Docling Serve client — POST /v1/convert/source (same contract the old .NET
 * repo used, verified there). `ocr` toggles do_ocr (Path C uses cheap CPU OCR;
 * Path B trusts the text layer), `tables` toggles TableFormer.
 */
export function createDoclingClient(baseUrl: string, timeoutMs = 300_000): DoclingPort {
  return {
    async convert(pdf, opts) {
      const body = {
        options: {
          to_formats: ["json", "md"],
          do_ocr: opts.ocr,
          do_table_structure: opts.tables,
          image_export_mode: "placeholder",
        },
        sources: [
          {
            kind: "file",
            base64_string: Buffer.from(pdf).toString("base64"),
            filename: "document.pdf",
          },
        ],
      };
      const res = await fetch(`${baseUrl}/v1/convert/source`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`docling convert failed: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as {
        document?: { json_content?: unknown; md_content?: string | null };
      };
      if (!json.document?.json_content) {
        throw new Error("docling response missing document.json_content");
      }
      return {
        doclingJson: json.document.json_content,
        markdown: json.document.md_content ?? "",
      };
    },
  };
}
