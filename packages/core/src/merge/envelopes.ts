import type { CandidateInvoice, ExtractionEnvelope } from "../schema/candidate";

/**
 * Merge extraction envelopes: PRIMARY wins per field, secondary fills gaps
 * (briefing §3: template result wins, generic rules fill). Line items and the
 * VAT breakdown are taken wholesale from whichever source has them (primary
 * preferred) — mixing rows from two extractors is never meaningful.
 */
export function mergeEnvelopes(
  primary: ExtractionEnvelope,
  secondary: ExtractionEnvelope,
): ExtractionEnvelope {
  const p = primary.invoice;
  const s = secondary.invoice;
  const meta = { ...secondary.fieldMeta, ...primary.fieldMeta };

  const pick = <K extends keyof CandidateInvoice>(key: K): CandidateInvoice[K] => {
    const pv = p[key];
    return pv !== undefined && pv !== null ? pv : s[key];
  };

  const totals =
    p.totals || s.totals
      ? {
          net: p.totals?.net ?? s.totals?.net ?? null,
          tax: p.totals?.tax ?? s.totals?.tax ?? null,
          gross: p.totals?.gross ?? s.totals?.gross ?? null,
        }
      : undefined;

  const seller =
    p.seller || s.seller
      ? {
          name: p.seller?.name ?? s.seller?.name ?? null,
          ustIdNr: p.seller?.ustIdNr ?? s.seller?.ustIdNr ?? null,
          steuernummer: p.seller?.steuernummer ?? s.seller?.steuernummer ?? null,
          ibans:
            (p.seller?.ibans?.length ?? 0) > 0 ? p.seller!.ibans! : (s.seller?.ibans ?? []),
          address: p.seller?.address ?? s.seller?.address ?? null,
        }
      : undefined;

  const invoice: CandidateInvoice = {
    invoiceNumber: pick("invoiceNumber"),
    issueDate: pick("issueDate"),
    dueDate: pick("dueDate"),
    currency: pick("currency"),
    locale: pick("locale"),
    buyer: pick("buyer"),
    paymentTerms: pick("paymentTerms"),
    ...(totals ? { totals } : {}),
    ...(seller ? { seller } : {}),
    vatBreakdown: (p.vatBreakdown?.length ?? 0) > 0 ? p.vatBreakdown : s.vatBreakdown,
    lineItems: (p.lineItems?.length ?? 0) > 0 ? p.lineItems : s.lineItems,
  };

  return { invoice, fieldMeta: meta };
}
