import { z } from "zod";
import { zDocumentType } from "./documentType";
import { documentProfiles } from "../reconcile/profiles";

/**
 * Canonical document schema — the single output contract for every extraction
 * path (briefing §1/§11). Monetary and quantity values are string-encoded
 * dot-decimals ("1234.56"): exact, JSON-safe, and regex-constrainable for VLM
 * schema-guided decoding. Parse to Decimal at module boundaries, never to float.
 *
 * v2 generalized this from invoices to the five document classes in
 * ./documentType: invoiceNumber/issueDate became documentNumber/documentDate,
 * and `documentType` was added. The type is still named CanonicalInvoice
 * because "invoice" is what the pipeline is for; the fields are not, because a
 * Lieferschein has no invoice number.
 */

/** Money amount, 2 decimal places max (header totals, line totals, VAT amounts). */
export const zMoney = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/);
/** Unit price — real invoices print up to 4 decimal places. */
export const zUnitPrice = z.string().regex(/^-?\d{1,12}(\.\d{1,4})?$/);
/** Quantity, 4 decimal places max. */
export const zQuantity = z.string().regex(/^-?\d{1,12}(\.\d{1,4})?$/);
/** VAT rate in percent (19, 7, 0, ...). */
export const zRate = z.number().min(0).max(100);
export const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const zPostalAddress = z.object({
  street: z.string().nullable(),
  postalCode: z.string().nullable(),
  city: z.string().nullable(),
  countryCode: z.string().length(2).nullable(),
});

/** Vendor identity block — feeds composite vendor-ID resolution (briefing §3). */
export const zSeller = z.object({
  name: z.string().min(1),
  ustIdNr: z.string().nullable(),
  steuernummer: z.string().nullable(),
  ibans: z.array(z.string()),
  address: zPostalAddress.nullable(),
});

export const zBuyer = z.object({
  name: z.string().nullable(),
  customerNumber: z.string().nullable(),
  address: zPostalAddress.nullable(),
});

export const zVatEntry = z.object({
  rate: zRate,
  net: zMoney,
  tax: zMoney,
});

export const zLineItem = z.object({
  position: z.number().int().nullable(),
  /** Mandatory for every line (briefing §1). */
  description: z.string().min(1),
  quantity: zQuantity.nullable(),
  unit: z.string().nullable(),
  unitPrice: zUnitPrice.nullable(),
  taxRate: zRate.nullable(),
  /** Net line total (user decision: net semantics; gross-line docs escalate). */
  lineTotal: zMoney.nullable(),
});

export const zTotals = z.object({
  net: zMoney,
  tax: zMoney,
  gross: zMoney,
});

/**
 * The canonical shape as a PLAIN object, with no refinements.
 *
 * This is the schema handed to z.toJSONSchema for VLM schema-constrained
 * decoding (schema/jsonSchema.ts, schema/vlm.ts). A custom check cannot be
 * represented in JSON Schema, so the refined schema below must never reach that
 * path — if it does, constrained decoding breaks at runtime with a green build.
 * Generate from this one, validate with the refined one.
 */
export const zCanonicalInvoiceShape = z.object({
  schemaVersion: z.literal(2),
  /** Which of the five document classes this is (./documentType.ts). */
  documentType: zDocumentType,
  /** Invoice number, AB number, Lieferschein number — whatever this class calls it. */
  documentNumber: z.string().min(1),
  documentDate: zIsoDate,
  dueDate: zIsoDate.nullable(),
  currency: z.string().length(3),
  locale: z.string().nullable(),
  seller: zSeller,
  buyer: zBuyer.nullable(),
  /** Null only where the class permits it — a priceless Lieferschein. */
  totals: zTotals.nullable(),
  /** Emptiness is likewise class-dependent; the refinement below enforces it. */
  vatBreakdown: z.array(zVatEntry),
  lineItems: z.array(zLineItem).min(1),
  paymentTerms: z.string().nullable(),
});

/**
 * The validation contract: the shape plus the per-class amount requirements
 * (reconcile/profiles.ts). The solver's required-field gate fires first and
 * with better diagnostics; this is the backstop that keeps the contract honest
 * for every other caller, human review included.
 */
export const zCanonicalInvoice = zCanonicalInvoiceShape.superRefine((doc, ctx) => {
  const profile = documentProfiles[doc.documentType];
  if (profile.requireTotals && doc.totals === null) {
    ctx.addIssue({
      code: "custom",
      path: ["totals"],
      message: "totals are required for documentType " + doc.documentType,
    });
  }
  if (profile.requireVat && doc.vatBreakdown.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["vatBreakdown"],
      message: "at least one VAT entry is required for documentType " + doc.documentType,
    });
  }
});

export type PostalAddress = z.infer<typeof zPostalAddress>;
export type Seller = z.infer<typeof zSeller>;
export type Buyer = z.infer<typeof zBuyer>;
export type VatEntry = z.infer<typeof zVatEntry>;
export type LineItem = z.infer<typeof zLineItem>;
export type Totals = z.infer<typeof zTotals>;
export type CanonicalInvoice = z.infer<typeof zCanonicalInvoiceShape>;
