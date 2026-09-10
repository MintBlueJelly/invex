import type { DocumentType } from "../schema/documentType";

/**
 * UNTDID 1001 document type code (BT-3) → InvEx document class.
 *
 * Path A is the one lane that never runs the classifier — zugferd.ts goes
 * straight from XML to the solver — so BT-3 is the only class signal available
 * there. Reading it stops being optional once the canonical schema carries a
 * documentType: without it, a 381 credit note would be *persisted* as an
 * invoice rather than merely mislabeled in passing, which is worse.
 *
 * A lookup table rather than a branch chain, deliberately: no branches to
 * cover, and adding a code is a one-line data change.
 *
 * Deliberately NOT done here: rejecting unknown codes. EN 16931 Schematron
 * validation is an explicit MVP scope cut (briefing §2, §9) and this must stay
 * a mapping, not a gate.
 */
const TYPE_CODES: Readonly<Record<string, DocumentType>> = {
  // Invoice family
  "380": "invoice", // Commercial invoice
  "384": "invoice", // Corrected invoice
  "386": "invoice", // Prepayment invoice
  "389": "invoice", // Self-billed invoice
  "326": "invoice", // Partial invoice
  "394": "invoice", // Lease invoice
  "395": "invoice", // Consignment invoice
  // Credit-note family. Note 389 above is self-billed *invoice*; a self-billed
  // credit note is 261, and both are economically invoices to the recipient —
  // see the Gutschriftverfahren note in reconcile/profiles.ts.
  "381": "creditNote", // Credit note
  "83": "creditNote", // Credit note related to financial adjustments
  "261": "creditNote", // Self-billed credit note
  // Order family. Present for completeness: an order response is normally
  // exchanged as its own root element, not as a CrossIndustryInvoice, so these
  // are not expected to arrive on Path A in practice.
  "220": "orderConfirmation", // Order
  "221": "orderConfirmation", // Blanket order
  "226": "orderConfirmation", // Partial invoice for order
  "231": "orderConfirmation", // Order response
  // Despatch family
  "270": "deliveryNote", // Delivery note
  "351": "deliveryNote", // Despatch advice
  // Quotation
  "310": "quote", // Quotation
};

/**
 * Maps a raw BT-3 value to a document class.
 *
 * Returns `invoice` for an absent or unrecognised code: that is the dominant
 * real case for a CrossIndustryInvoice and preserves the behaviour every
 * pre-existing document was extracted under. Callers should log the raw code
 * so unmapped ones surface in the trace rather than disappearing.
 */
export function documentTypeFromCiiTypeCode(raw: string | null): DocumentType {
  if (raw === null) return "invoice";
  return TYPE_CODES[raw.trim()] ?? "invoice";
}

/** The BT-3 code InvEx emits for a document class (used by the fixtures). */
export function ciiTypeCodeFor(type: DocumentType): string {
  switch (type) {
    case "creditNote":
      return "381";
    case "orderConfirmation":
      return "231";
    case "deliveryNote":
      return "270";
    case "quote":
      return "310";
    case "invoice":
      return "380";
  }
}
