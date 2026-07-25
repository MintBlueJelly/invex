export { computeInvoice, sampleSpec, type ComputedInvoice, type FixtureLine, type InvoiceSpec } from "./spec";
export { serializeCii } from "./ciiXml";
export { serializeCiiFromCanonical, type CiiDefects } from "./ciiFromCanonical";
export {
  defaultLabels,
  deDate,
  deMoney,
  makeGarbageTextPdf,
  makeLetterPdf,
  makeTextInvoicePdf,
  type TextPdfLabels,
} from "./textPdf";
export { makeMalformedZugferdPdf, makeZugferdPdf } from "./zugferdPdf";
export { makeScannedPdf } from "./scannedPdf";

// ── golden scenarios (the oracle) ───────────────────────────────────────────
// The literal/layout/render seam replaces the computeInvoice-derived fixtures
// above; those remain only until the legacy tests listed in
// packages/fixtures/test/unit/goldenPurity.test.ts have been migrated.
export type { LiteralInvoiceDoc, LiteralLine, LiteralSeller, LiteralTotalsRow } from "./literal/spec";
export {
  layoutInvoice,
  opWidth,
  type DrawOp,
  type DrawRole,
  type LayoutOptions,
  type PageLayout,
  type TableRegion,
} from "./layout/invoiceLayout";
export { renderPdf } from "./render/toPdf";
export { renderDoclingJson } from "./render/toDoclingJson";
export { renderOcrDoclingJson } from "./render/toOcrDoclingJson";
export {
  goldenDocling,
  goldenOcrDocling,
  goldenPdf,
  isSynthetic,
  layoutOf,
  loadGolden,
  loadGoldens,
  SCENARIOS_DIR,
  type Golden,
  type GoldenSmoke,
} from "./goldens";
