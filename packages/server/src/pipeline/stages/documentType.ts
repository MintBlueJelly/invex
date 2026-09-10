import type { DocumentType, ExtractionEnvelope } from "@invex/core";

/**
 * Stamp the classifier's document class onto an extraction envelope.
 *
 * The class decides which validation profile the solver applies
 * (reconcile/profiles.ts), so it has to travel with the candidate rather than
 * being re-derived downstream. Both text and image lanes go through here so
 * Path B and Path C cannot drift.
 *
 * A null kind is left null rather than defaulted here: the solver's default to
 * "invoice" is the single place that decision lives, and writing it twice would
 * make the envelope claim a certainty the classifier never had.
 */
export function withDocumentType(
  envelope: ExtractionEnvelope,
  kind: DocumentType | null,
): ExtractionEnvelope {
  if (kind === null) return envelope;
  return {
    invoice: { ...envelope.invoice, documentType: kind },
    fieldMeta: {
      ...envelope.fieldMeta,
      documentType: { source: "rules", confidence: 0.9 },
    },
  };
}
