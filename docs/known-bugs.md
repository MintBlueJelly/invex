# Known bugs

Every row here is pinned by at least one test using the `knownBug()` helper
(`test-utils/knownBug.ts`), and every id used by a test appears here. Both directions are
enforced by `packages/core/test/unit/knownBugs.registry.test.ts`, so this file cannot drift
away from the suite: removing the last test for an id forces removing its row, and adding a
row forces adding a test.

**Status.** `open` — the defect exists and its pins are `it.fails()`. `fixed` — repaired; the
pins were promoted to ordinary tests and the row is kept for history. A row that is `fixed`
must have no `knownBug()` call left referencing it.

Run `pnpm test:known-bugs` to see what is still broken. That run is *expected* to be red.

**Severity** is deployment-weighted, not code-weighted, per `DEPLOYMENT.md`: single replica,
`Recreate`, in-process worker, every ingested PDF stored only in Postgres.

- **critical** — silently produces wrong financial data, or wedges the queue.
- **high** — loses data, blocks a document class entirely, or discloses internals.
- **medium** — wrong behaviour with a visible symptom.

| id | severity | status | defect | where | pinned by |
| --- | --- | --- | --- | --- | --- |
| INVEX-004 | critical | fixed | `PUT /api/review/:id` validated shape only (`zCanonicalInvoice` is a plain `z.object`, no refinements), never re-ran the solver, and then induced a **vendor template** from the unchecked numbers — so one typo in review anchored wrong values for every future invoice from that vendor. | `packages/server/src/http/review.ts:60` | `packages/server/test/component/http/review.arithmetic.test.ts` |
| INVEX-002 | critical | fixed | OCR column bands were assigned by a token's left edge with a flat 0.02 tolerance. Amount columns are right-aligned, so a value wider than its header starts left of it and fell into the previous column — shifting the **whole row** one column across: `quantity` became `"2199.50"` (quantity fused with unit price) and `unitPrice` silently held the line total. Every value stayed schema-valid. | `packages/core/src/template/applyOcr.ts:77` | `packages/core/test/unit/template/applyOcr.test.ts` |
| INVEX-001 | critical | fixed | `amountVariants()` included the raw dot-decimal form in **both** locale candidate sets, so `detectLocale` could never return `"."`. An ungrouped English page was induced as `decimal: ","`, and the persisted template then read every amount 100× too large — permanently, for that vendor. Silent whenever the VAT arithmetic is exact (round net amounts), because scaling preserves every constraint; caught by `C4_VAT_SUM` only when a rounding residue exists to be scaled with it. | `packages/core/src/template/induce.ts:57` | `packages/core/test/unit/template/induce.locale.test.ts` |
| INVEX-005 | high | fixed | `normBbox` defaulted a missing `pages[].size` to `1`, so every bbox in the document normalized to `[1,1,1,1]`. All positional logic — region anchors, the classifier's heading-position feature, the segmenter, OCR x-bands — then ran on degenerate geometry with no diagnostic. | `packages/core/src/docling/mapDocument.ts:67` | `packages/core/test/unit/docling/mapDocument.test.ts` |
| INVEX-006 | critical | fixed | `rasterizePdf` had no page-dimension guard. A PDF declaring a 200x200 inch MediaBox asks for ~30000x30000 = 900 MP (~3.6 GB RGBA) at the configured 150 dpi; the OOM kill rolls the claim transaction back **without incrementing `attempts`**, so the document is re-claimed first on every restart and wedges the queue. | `packages/server/src/pdf/rasterize.ts:17` | `packages/server/test/unit/pdf/rasterize.test.ts` |
| INVEX-011 | high | fixed | Three defects in the vendor template store: `version` computed in application code (lost update); `listTemplates` sorted **ascending** by `updatedAt`, returning the oldest templates and never newly learned ones; and a non-matching USt-IdNr did not stop IBAN resolution, so two vendors sharing a payment-provider IBAN collapsed into one row and the second **overwrote the first's identity**. | `packages/server/src/db/repos/templates.ts:71` | `packages/server/test/component/repos/templates.integrity.test.ts` |
| INVEX-007 | critical | fixed | A stage error returned "processed", skipping the loop's poll sleep. Claims are oldest-first and the row was still under `maxAttempts`, so the next tick re-claimed the **same** document immediately — all three attempts burned in one event-loop burst. One docling restart or one llama-swap 503 during a cold model load permanently `failed`ed every in-flight document. No `uncaughtException` handler either, so a crash left no line naming the document. | `packages/server/src/pipeline/machine.ts:64` | `packages/server/test/component/machine.retry.test.ts` |
| INVEX-009 | high | fixed | `/health` always returned HTTP 200 — a Kubernetes probe could never fail — and reported nothing about the worker, so `{"status":"ok"}` was fully compatible with a server that ingests documents and never processes one. `DEPLOYMENT.md` lists this first in its troubleshooting table and calls it structurally undetectable. | `packages/server/src/http/app.ts:192` | `packages/server/test/component/http/health.test.ts` |
| INVEX-008 | high | fixed | Path `:id` and `?documentId=` were passed unvalidated to a uuid column, so a malformed value raised Postgres 22P02 and Fastify returned **500 with the failed SQL statement and its bound parameters in the body**. `?limit=abc` became `NaN`, survived the clamp, and reached `.limit(NaN)`. | `packages/server/src/http/app.ts:119` | `packages/server/test/component/http/validation.test.ts` |
| INVEX-010 | high | fixed | `vatSynth`'s `v.rate > 0` guard meant a `{rate: 0, tax: "0.00", net: null}` entry — the exact shape `runRuleEngine` emits — could never be completed, so **every §19 Kleinunternehmer and §13b reverse-charge invoice** failed `VAT_INCOMPLETE` and escalated. | `packages/core/src/reconcile/repairs.ts:94` | `packages/core/test/unit/reconcile/zeroRateVat.test.ts` |
| INVEX-012 | medium | open | Bare `"Rechnung"` is an `invoiceNumber` label and the value pattern accepts dots, so `"Rechnung 12.06.2026"` yields an invoice number of `12.06.2026`. | `packages/core/src/rules/lexicon.ts:31` | `packages/core/test/unit/rules/engine.test.ts` |

<!-- Rows are added in Phase F (fixes, promoted immediately) and Phase 1 (deferred defects,
     pinned only). Keep the table sorted by id. -->
