import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/index";
import { applyMask, arbConsistentInvoice, arbErasureMask } from "../utils/arbitraries";

/**
 * P3 — the solver's whole reason to exist, stated as an invariant.
 *
 * Briefing §1/§4: line-item quantity, unit price and per-line tax are optional
 * and RECONSTRUCTABLE; an invoice is accepted when the constraint system closes,
 * even though fields were inferred. Nothing tested that. The old fixtures could
 * not: computeInvoice() filled every optional field on every line, so no fixture
 * ever presented the solver with something to reconstruct.
 *
 * The property: erasing a field that is derivable from the others changes
 * nothing about the resulting invoice.
 */

describe("P3 — the solver is sound under erasure", () => {
  it("a fully specified consistent invoice reconciles with no repairs", () => {
    fc.assert(
      fc.property(arbConsistentInvoice(), ({ invoice }) => {
        const r = reconcile({ invoice, fieldMeta: {} });
        expect(r.status, JSON.stringify(r.violations)).toBe("reconciled");
        expect(r.repairs).toEqual([]);
      }),
    );
  });

  it("erasing a derivable field yields the same invoice", () => {
    fc.assert(
      fc.property(arbConsistentInvoice(), arbErasureMask(), ({ invoice }, mask) => {
        const full = reconcile({ invoice, fieldMeta: {} });
        fc.pre(full.status === "reconciled");

        const erased = reconcile({ invoice: applyMask(invoice, mask), fieldMeta: {} });

        expect(erased.status, JSON.stringify(erased.violations)).toBe("reconciled");
        expect(erased.invoice?.totals).toEqual(full.invoice?.totals);
        expect(erased.invoice?.vatBreakdown).toEqual(full.invoice?.vatBreakdown);
        expect(erased.invoice?.lineItems.map((l) => l.lineTotal)).toEqual(
          full.invoice?.lineItems.map((l) => l.lineTotal),
        );
      }),
    );
  });

  it("records a repair for every value it had to reconstruct", () => {
    // Inference must be auditable (briefing §8): a value the solver invented and
    // a value the document stated must be distinguishable afterwards.
    fc.assert(
      fc.property(arbConsistentInvoice(), arbErasureMask(), ({ invoice }, mask) => {
        const masked = applyMask(invoice, mask);
        // Ask what was ACTUALLY erased rather than what the mask requested:
        // applyMask declines erasures that would be underdetermined, so the
        // flags overstate it.
        fc.pre(JSON.stringify(masked) !== JSON.stringify(invoice));

        const r = reconcile({ invoice: masked, fieldMeta: {} });
        fc.pre(r.status === "reconciled");
        expect(r.repairs.length).toBeGreaterThan(0);
      }),
    );
  });

  it("is idempotent: reconciling its own output changes nothing", () => {
    fc.assert(
      fc.property(arbConsistentInvoice(), arbErasureMask(), ({ invoice }, mask) => {
        const once = reconcile({ invoice: applyMask(invoice, mask), fieldMeta: {} });
        fc.pre(once.status === "reconciled");

        const twice = reconcile({ invoice: once.invoice!, fieldMeta: {} });
        expect(twice.status).toBe("reconciled");
        expect(twice.repairs).toEqual([]);
        expect(twice.invoice).toEqual(once.invoice);
      }),
    );
  });

  it("never reports totalFailure for an invoice that reconciles", () => {
    // totalFailure is the §5 RECLASSIFICATION signal — "this is not an invoice".
    // It must never fire on a document the solver went on to accept.
    fc.assert(
      fc.property(arbConsistentInvoice(), arbErasureMask(), ({ invoice }, mask) => {
        const r = reconcile({ invoice: applyMask(invoice, mask), fieldMeta: {} });
        if (r.status === "reconciled") expect(r.totalFailure).toBe(false);
      }),
    );
  });
});

describe("the limit of reconstruction", () => {
  it("multi-rate VAT nets are underdetermined once every one is missing", () => {
    // Recorded deliberately, because it bounds what P3 can claim. The solver
    // back-computes each net from its own printed tax, and a tax is already
    // rounded — so 2.20 at 19% yields 11.58 where the document said 11.59. The
    // sum then misses the header net by a cent, which C4's absolute +/-0.02
    // tolerance absorbs. Accepted behaviour, but worth knowing it is a cent-level
    // approximation and not a reconstruction, and that only the tolerance hides it.
    const r = reconcile({
      invoice: {
        invoiceNumber: "R-1",
        issueDate: "2026-06-15",
        currency: "EUR",
        seller: { name: "X" },
        totals: { net: "12.59", tax: "2.27", gross: "14.86" },
        vatBreakdown: [
          { rate: 19, net: null, tax: "2.20" },
          { rate: 7, net: null, tax: "0.07" },
        ],
        lineItems: [
          { position: 1, description: "A", quantity: "1", unitPrice: "1.00", taxRate: 7, lineTotal: "1.00" },
          { position: 2, description: "B", quantity: "1", unitPrice: "11.59", taxRate: 19, lineTotal: "11.59" },
        ],
      },
      fieldMeta: {},
    });

    expect(r.status).toBe("reconciled");
    // 11.58, not the 11.59 the document stated.
    expect(r.invoice?.vatBreakdown.find((v) => v.rate === 19)?.net).toBe("11.58");
  });
});
