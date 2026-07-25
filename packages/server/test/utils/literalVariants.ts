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
  invoiceNumber: string,
  issueDate?: string,
): LiteralInvoiceDoc {
  return {
    ...base,
    headerFields: base.headerFields.map((f) => {
      if (f.labelText === "Rechnungs-Nr.") return { ...f, valueText: invoiceNumber };
      if (issueDate && f.labelText === "Rechnungsdatum") return { ...f, valueText: issueDate };
      return f;
    }),
  };
}
