import type { LiteralInvoiceDoc } from "@invex/fixtures";

/**
 * Same layout, different Rechnungs-Nr. / Rechnungsdatum header values.
 *
 * Several integration tests need a SECOND document from the same vendor (to
 * exercise template re-application) or just a fresh, uniquely-hashable PDF —
 * without re-deriving the page from computeInvoice/sampleSpec. Reshaping a
 * golden's own literal doc keeps the vendor/geometry real while giving each
 * call distinct content.
 */
export function withInvoiceNumber(
  base: LiteralInvoiceDoc,
  documentNumber: string,
  documentDate?: string,
): LiteralInvoiceDoc {
  return {
    ...base,
    headerFields: base.headerFields.map((f) => {
      if (f.labelText === "Rechnungs-Nr.") return { ...f, valueText: documentNumber };
      if (documentDate && f.labelText === "Rechnungsdatum") return { ...f, valueText: documentDate };
      return f;
    }),
  };
}
