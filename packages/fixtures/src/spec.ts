import Decimal from "decimal.js";

/**
 * Declarative invoice spec for fixture generation. All amounts are dot-decimal
 * strings; computeInvoice fills consistent totals/VAT from the lines so every
 * generator (text PDF, CII XML, scanned image) renders the same arithmetic truth.
 */

export interface FixtureLine {
  description: string;
  quantity?: string;
  unit?: string;
  unitPrice?: string;
  taxRate?: number;
  lineTotal?: string;
}

export interface InvoiceSpec {
  invoiceNumber: string;
  issueDate: string; // ISO
  dueDate?: string;
  currency?: string;
  seller: {
    name: string;
    ustIdNr?: string;
    steuernummer?: string;
    iban?: string;
    street?: string;
    postalCode?: string;
    city?: string;
  };
  buyerName?: string;
  lines: FixtureLine[];
  paymentTerms?: string;
}

export interface ComputedLine {
  position: number;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  taxRate: number;
  lineTotal: string;
}

export interface ComputedInvoice {
  spec: InvoiceSpec;
  currency: string;
  lines: ComputedLine[];
  vat: { rate: number; net: string; tax: string }[];
  totals: { net: string; tax: string; gross: string };
}

const D = (v: string | number) => new Decimal(v);
const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export function computeInvoice(spec: InvoiceSpec): ComputedInvoice {
  const lines: ComputedLine[] = spec.lines.map((l, i) => {
    const quantity = l.quantity ?? "1";
    const taxRate = l.taxRate ?? 19;
    const unitPrice =
      l.unitPrice ?? (l.lineTotal ? money(D(l.lineTotal).div(D(quantity))) : "0.00");
    const lineTotal = l.lineTotal ?? money(D(quantity).times(D(unitPrice)));
    return {
      position: i + 1,
      description: l.description,
      quantity,
      unit: l.unit ?? "Stk",
      unitPrice,
      taxRate,
      lineTotal,
    };
  });

  const byRate = new Map<number, Decimal>();
  for (const l of lines) {
    byRate.set(l.taxRate, (byRate.get(l.taxRate) ?? D(0)).plus(D(l.lineTotal)));
  }
  const vat = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, net]) => ({
      rate,
      net: money(net),
      tax: money(net.times(rate).div(100)),
    }));

  const net = vat.reduce((a, v) => a.plus(D(v.net)), D(0));
  const tax = vat.reduce((a, v) => a.plus(D(v.tax)), D(0));
  return {
    spec,
    currency: spec.currency ?? "EUR",
    lines,
    vat,
    totals: { net: money(net), tax: money(tax), gross: money(net.plus(tax)) },
  };
}

/** The default sample vendor used across fixtures (checksum-valid identifiers). */
export function sampleSpec(overrides?: Partial<InvoiceSpec>): InvoiceSpec {
  return {
    invoiceNumber: "R-2026-0042",
    issueDate: "2026-06-15",
    dueDate: "2026-07-15",
    currency: "EUR",
    seller: {
      name: "ACME Bürotechnik GmbH",
      ustIdNr: "DE811907980",
      iban: "DE02120300000000202051",
      street: "Industriestraße 12",
      postalCode: "80331",
      city: "München",
    },
    buyerName: "Beispiel AG",
    lines: [
      { description: "Aktenvernichter PS-500", quantity: "2", unitPrice: "199.50", taxRate: 19 },
      { description: "Wartungsvertrag Bürogeräte, Laufzeit 12 Monate", quantity: "1", unitPrice: "480.00", taxRate: 19 },
      { description: "Toner-Set CMYK", quantity: "3", unitPrice: "89.90", taxRate: 19 },
    ],
    paymentTerms: "Zahlbar innerhalb von 30 Tagen ohne Abzug.",
    ...overrides,
  };
}
