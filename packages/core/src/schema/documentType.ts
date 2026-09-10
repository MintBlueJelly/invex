import { z } from "zod";

/**
 * The document classes InvEx extracts into the canonical schema.
 *
 * All five share the invoice's structure — seller, line-item table, VAT
 * breakdown, totals — and therefore run the identical extraction path and the
 * identical constraint solver. What varies is only which of those parts a type
 * is REQUIRED to carry; see reconcile/profiles.ts.
 *
 * This is a document class, not a confidence band. `ClassifierBand`
 * (classify/classifier.ts) answers "how sure are we this is a structured
 * commercial document"; `DocumentType` answers "which one". The two axes are
 * deliberately orthogonal — see the glossary entry for `band`.
 *
 * Anything outside this set (letter, contract, terms and conditions, reminder)
 * has no DocumentType and takes the Markdown-export path.
 */
export const DOCUMENT_TYPES = [
  "invoice",
  "creditNote",
  "orderConfirmation",
  "deliveryNote",
  "quote",
] as const;

export const zDocumentType = z.enum(DOCUMENT_TYPES);
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
