// Canonical schema + envelope
export * from "./schema/documentType";
export * from "./schema/invoice";
export * from "./schema/candidate";
export * from "./schema/markdown";
export * from "./schema/jsonSchema";
export { vlmResultJsonSchema, zVlmResult, type VlmResult } from "./schema/vlm";

// Constraint solver / reconciler
export * from "./reconcile/types";
export { reconcile } from "./reconcile/solver";

// ZUGfERD / Factur-X (CII) parsing
export { parseCiiToEnvelope } from "./zugferd/cii";

// Positioned-text model (shared representation for templates/rules/classifier)
export * from "./positioned/model";
export { mergeLines } from "./positioned/mergeLines";

// Locale-aware parsing
export * from "./parsing/amounts";
export * from "./parsing/dates";

// Vendor identity: checksums + extraction
export * from "./vendor/checksums";
export { extractVendorIds, type ExtractedVendorIds } from "./vendor/extract";

// Vendor templates: types + apply + induce
export * from "./template/types";
export { applyTemplate, matchTable, type TemplateApplication } from "./template/apply";
export { applyTemplateOcr } from "./template/applyOcr";
export { induceTemplate, templateIsUseful } from "./template/induce";

// Text-quality gate + page segmentation (Path B pre-stages)
export { runTextGate, type TextGateOptions, type TextGateResult } from "./textquality/gate";
export { segmentPages, slicePages, type Segment } from "./segment/segmentPages";

// Docling mapping
export { mapDoclingDocument } from "./docling/mapDocument";

// Generic rule engine + lexicon
export { runRuleEngine, type RuleEngineResult } from "./rules/engine";
export { defaultLexicon, type Lexicon } from "./rules/lexicon";

// Classifier: weighted band (confidence) + document class (kind)
export {
  classify,
  positionedToMarkdown,
  type ClassificationResult,
  type ClassifierBand,
  type ClassifierConfigCore,
} from "./classify/classifier";
export { detectKind, isHeadingCandidate, type KindEvidence } from "./classify/kind";

// Keyword-matching text fold (diacritics/ß, separator-preserving)
export { foldText, spellingVariants } from "./text/fold";

// Envelope merge
export { mergeEnvelopes } from "./merge/envelopes";
