import { type DocumentType } from "../schema/documentType";

/**
 * Per-document-class validation profile: which parts of the canonical shape a
 * class is REQUIRED to carry.
 *
 * What this table does NOT do is select constraints. C1–C5 run for every class,
 * always, because constraints.ts already returns `evaluable: false` for any
 * check whose operands are missing. A priceless Lieferschein therefore produces
 * zero violations without a single extra branch, and a Lieferschein that DOES
 * print a Warenwert and per-line values gets byte-identical arithmetic
 * treatment to an invoice. Gating constraints by class would forfeit the
 * second case to buy the first, which is already free.
 *
 * The only thing that ever rejected a priceless delivery note was the
 * required-field gate in solver.ts, which is what this table replaces.
 */
export interface DocumentProfile {
  /** Header totals must complete (else TOTALS_INCOMPLETE). */
  requireTotals: boolean;
  /** At least one complete VAT entry (else VAT_MISSING / VAT_INCOMPLETE). */
  requireVat: boolean;
  /** At least one line item (else LINE_ITEMS_MISSING). */
  requireLineItems: boolean;
}

/**
 * Note on `creditNote`: no sign constraint, deliberately.
 *
 * "Gutschrift" is two different documents wearing one word. It is both a credit
 * note (UNTDID 381, typically negative) and the Gutschriftverfahren — German
 * self-billing, where the BUYER issues the document (UNTDID 389), economically
 * an invoice with positive amounts and the party roles reversed. A heading
 * cannot tell them apart, so a "credit notes must be negative" rule would
 * false-fail every self-billed one. zMoney already permits negatives, C1 is
 * sign-agnostic, and C4's net × rate = tax holds for negatives, so the
 * arithmetic needs no help here.
 */
export const documentProfiles: Readonly<Record<DocumentType, DocumentProfile>> = {
  invoice: { requireTotals: true, requireVat: true, requireLineItems: true },
  creditNote: { requireTotals: true, requireVat: true, requireLineItems: true },
  // An order confirmation, a quote and a credit note all print prices, a VAT
  // summary and totals. Relaxing them would silently forfeit the arithmetic
  // validation that is the whole point of routing them here; one that genuinely
  // prints no VAT block fails VAT_MISSING and escalates, which is correct — a
  // human should see that.
  orderConfirmation: { requireTotals: true, requireVat: true, requireLineItems: true },
  quote: { requireTotals: true, requireVat: true, requireLineItems: true },
  // A Lieferschein normally prints what was delivered and no money at all. Its
  // line items are still first-class data (briefing §1: "data about invoiced
  // products and services"), so they stay required; the amounts do not.
  deliveryNote: { requireTotals: false, requireVat: false, requireLineItems: true },
};

export function profileFor(type: DocumentType): DocumentProfile {
  return documentProfiles[type];
}
