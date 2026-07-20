import { z } from "zod";

/**
 * Canonical invoice schema — the single output contract for every extraction path
 * (briefing §1/§11). Monetary and quantity values are string-encoded dot-decimals
 * ("1234.56"): exact, JSON-safe, and regex-constrainable for VLM schema-guided
 * decoding. Parse to Decimal at module boundaries, never to float.
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

export const zCanonicalInvoice = z.object({
  schemaVersion: z.literal(1),
  invoiceNumber: z.string().min(1),
  issueDate: zIsoDate,
  dueDate: zIsoDate.nullable(),
  currency: z.string().length(3),
  locale: z.string().nullable(),
  seller: zSeller,
  buyer: zBuyer.nullable(),
  totals: zTotals,
  vatBreakdown: z.array(zVatEntry).min(1),
  lineItems: z.array(zLineItem).min(1),
  paymentTerms: z.string().nullable(),
});

export type PostalAddress = z.infer<typeof zPostalAddress>;
export type Seller = z.infer<typeof zSeller>;
export type Buyer = z.infer<typeof zBuyer>;
export type VatEntry = z.infer<typeof zVatEntry>;
export type LineItem = z.infer<typeof zLineItem>;
export type Totals = z.infer<typeof zTotals>;
export type CanonicalInvoice = z.infer<typeof zCanonicalInvoice>;
