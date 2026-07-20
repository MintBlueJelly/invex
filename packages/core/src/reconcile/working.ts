import Decimal from "decimal.js";
import type { CandidateInvoice } from "../schema/candidate";

/**
 * Internal mutable working model the solver operates on: every numeric field is
 * Decimal | null so "missing" is first-class (never conflated with zero).
 */

export interface WorkingLine {
  position: number | null;
  description: string;
  quantity: Decimal | null;
  unit: string | null;
  unitPrice: Decimal | null;
  taxRate: number | null;
  lineTotal: Decimal | null;
}

export interface WorkingVatEntry {
  rate: number | null;
  net: Decimal | null;
  tax: Decimal | null;
}

export interface Working {
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  currency: string | null;
  locale: string | null;
  seller: {
    name: string | null;
    ustIdNr: string | null;
    steuernummer: string | null;
    ibans: string[];
    address: {
      street: string | null;
      postalCode: string | null;
      city: string | null;
      countryCode: string | null;
    } | null;
  };
  buyer: {
    name: string | null;
    customerNumber: string | null;
    address: {
      street: string | null;
      postalCode: string | null;
      city: string | null;
      countryCode: string | null;
    } | null;
  } | null;
  net: Decimal | null;
  tax: Decimal | null;
  gross: Decimal | null;
  vat: WorkingVatEntry[];
  lines: WorkingLine[];
  paymentTerms: string | null;
}

export function toDec(v: string | null | undefined): Decimal | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function cleanStr(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function toWorking(c: CandidateInvoice): Working {
  const sellerAddr = c.seller?.address ?? null;
  const buyerAddr = c.buyer?.address ?? null;
  return {
    invoiceNumber: cleanStr(c.invoiceNumber),
    issueDate: cleanStr(c.issueDate),
    dueDate: cleanStr(c.dueDate),
    currency: cleanStr(c.currency),
    locale: cleanStr(c.locale),
    seller: {
      name: cleanStr(c.seller?.name),
      ustIdNr: cleanStr(c.seller?.ustIdNr),
      steuernummer: cleanStr(c.seller?.steuernummer),
      ibans: (c.seller?.ibans ?? []).filter((i): i is string => typeof i === "string"),
      address: sellerAddr
        ? {
            street: cleanStr(sellerAddr.street),
            postalCode: cleanStr(sellerAddr.postalCode),
            city: cleanStr(sellerAddr.city),
            countryCode: cleanStr(sellerAddr.countryCode),
          }
        : null,
    },
    buyer: c.buyer
      ? {
          name: cleanStr(c.buyer.name),
          customerNumber: cleanStr(c.buyer.customerNumber),
          address: buyerAddr
            ? {
                street: cleanStr(buyerAddr.street),
                postalCode: cleanStr(buyerAddr.postalCode),
                city: cleanStr(buyerAddr.city),
                countryCode: cleanStr(buyerAddr.countryCode),
              }
            : null,
        }
      : null,
    net: toDec(c.totals?.net),
    tax: toDec(c.totals?.tax),
    gross: toDec(c.totals?.gross),
    vat: (c.vatBreakdown ?? []).map((v) => ({
      rate: v.rate ?? null,
      net: toDec(v.net),
      tax: toDec(v.tax),
    })),
    lines: (c.lineItems ?? []).map((l) => ({
      position: l.position ?? null,
      description: l.description,
      quantity: toDec(l.quantity),
      unit: cleanStr(l.unit),
      unitPrice: toDec(l.unitPrice),
      taxRate: l.taxRate ?? null,
      lineTotal: toDec(l.lineTotal),
    })),
    paymentTerms: cleanStr(c.paymentTerms),
  };
}

/** Money serialization: always 2 decimal places. */
export function moneyStr(d: Decimal): string {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** Quantity/unit-price serialization: up to 4 decimal places, at least none. */
export function qtyStr(d: Decimal): string {
  return d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();
}
