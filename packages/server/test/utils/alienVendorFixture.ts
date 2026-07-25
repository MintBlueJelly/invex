import type { CanonicalInvoice } from "@invex/core";
import { layoutInvoice, renderDoclingJson, type LiteralInvoiceDoc } from "@invex/fixtures";

/**
 * Same ACME invoice as de-standard-19 (same vendor, same arithmetic), but
 * every field label is alien to the rule engine's lexicon (Vorgangskennung
 * instead of Rechnungs-Nr., Absolutwert instead of Gesamtbetrag, ...) — the
 * deterministic rule engine must fail to match anything and escalate to
 * VLM/human review.
 *
 * No golden carries this: goldens are meant to be realistic invoices, and an
 * alien-label idiom is a deliberately synthetic failure case. Built through
 * the layout seam rather than a hand-typed DoclingDocument JSON blob.
 */
function alienLabelDoc(): LiteralInvoiceDoc {
  return {
    locale: "de",
    seller: {
      nameText: "ACME Bürotechnik GmbH",
      addressLines: [],
      taxIdLine: "USt-IdNr.: DE811907980",
    },
    headingText: "Rechnung",
    headerFields: [
      { labelText: "Vorgangskennung", valueText: "R-2026-0042" },
      { labelText: "Erstellt", valueText: "15.06.2026" },
    ],
    tableHeaders: ["Zeile", "Text", "Vol", "Kurs", "Absolut"],
    tableColumns: ["position", "description", "quantity", "unitPrice", "lineTotal"],
    lines: [
      {
        posText: "1",
        descriptionText: "Aktenvernichter PS-500",
        quantityText: "2",
        unitPriceText: "199,50",
        lineTotalText: "399,00",
      },
      { posText: "2", descriptionText: "Wartungsvertrag", quantityText: "1", unitPriceText: "480,00", lineTotalText: "480,00" },
      { posText: "3", descriptionText: "Toner-Set CMYK", quantityText: "3", unitPriceText: "89,90", lineTotalText: "269,70" },
    ],
    totalsBlock: [
      { labelText: "Basiswert", valueText: "1.148,70" },
      { labelText: "Abgabe 19%", valueText: "218,25" },
      { labelText: "Absolutwert", valueText: "1.366,95", bold: true },
    ],
  };
}

/** DoclingDocument JSON for Path B (rule-engine input) — table shape, alien labels. */
export function alienVendorDoclingJson(): unknown {
  return renderDoclingJson(layoutInvoice(alienLabelDoc()));
}

/** The invoice a human/VLM correctly reads off the alien-labeled page. */
export function alienVendorInvoice(): CanonicalInvoice {
  return {
    schemaVersion: 1,
    invoiceNumber: "R-2026-0042",
    issueDate: "2026-06-15",
    dueDate: null,
    currency: "EUR",
    locale: "de-DE",
    seller: {
      name: "ACME Bürotechnik GmbH",
      ustIdNr: "DE811907980",
      steuernummer: null,
      ibans: [],
      address: null,
    },
    buyer: null,
    totals: { net: "1148.70", tax: "218.25", gross: "1366.95" },
    vatBreakdown: [{ rate: 19, net: "1148.70", tax: "218.25" }],
    lineItems: [
      { position: 1, description: "Aktenvernichter PS-500", quantity: "2", unit: null, unitPrice: "199.50", taxRate: 19, lineTotal: "399.00" },
      { position: 2, description: "Wartungsvertrag", quantity: "1", unit: null, unitPrice: "480.00", taxRate: 19, lineTotal: "480.00" },
      { position: 3, description: "Toner-Set CMYK", quantity: "3", unit: null, unitPrice: "89.90", taxRate: 19, lineTotal: "269.70" },
    ],
    paymentTerms: null,
  };
}
