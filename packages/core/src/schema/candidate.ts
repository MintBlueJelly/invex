/**
 * Extraction envelope: a deep-partial candidate invoice plus per-field provenance.
 * Provenance lives OUTSIDE the canonical JSON (keyed by field path) so the canonical
 * schema stays a clean downstream contract and the exact VLM generation target.
 */

export type FieldSource =
  | "zugferd"
  | "template"
  | "rules"
  | "ocr"
  | "vlm"
  | "human"
  | "derived";

export interface FieldMeta {
  source: FieldSource;
  /** 0..1 */
  confidence: number;
  /** Verbatim text from the document, pre-normalization. */
  rawText?: string;
  /** Normalized page-relative bbox (0..1, origin top-left); page is 1-based. */
  anchor?: { page: number; bbox: [number, number, number, number] };
}

export interface CandidatePostalAddress {
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  countryCode?: string | null;
}

export interface CandidateSeller {
  name?: string | null;
  ustIdNr?: string | null;
  steuernummer?: string | null;
  ibans?: string[] | null;
  address?: CandidatePostalAddress | null;
}

export interface CandidateBuyer {
  name?: string | null;
  customerNumber?: string | null;
  address?: CandidatePostalAddress | null;
}

export interface CandidateVatEntry {
  rate?: number | null;
  net?: string | null;
  tax?: string | null;
}

export interface CandidateLineItem {
  position?: number | null;
  /** Description stays required even on candidates (briefing §1). */
  description: string;
  quantity?: string | null;
  unit?: string | null;
  unitPrice?: string | null;
  taxRate?: number | null;
  lineTotal?: string | null;
}

export interface CandidateInvoice {
  invoiceNumber?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  locale?: string | null;
  seller?: CandidateSeller | null;
  buyer?: CandidateBuyer | null;
  totals?: { net?: string | null; tax?: string | null; gross?: string | null } | null;
  vatBreakdown?: CandidateVatEntry[] | null;
  lineItems?: CandidateLineItem[] | null;
  paymentTerms?: string | null;
}

/** Field paths use dot/index notation: "totals.gross", "lineItems.2.unitPrice". */
export interface ExtractionEnvelope {
  invoice: CandidateInvoice;
  fieldMeta: Record<string, FieldMeta>;
}
