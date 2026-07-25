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
| INVEX-012 | medium | open | Bare `"Rechnung"` is an `invoiceNumber` label and the value pattern accepts dots, so `"Rechnung 12.06.2026"` yields an invoice number of `12.06.2026`. | `packages/core/src/rules/lexicon.ts:31` | `packages/core/test/unit/rules/engine.test.ts` |

<!-- Rows are added in Phase F (fixes, promoted immediately) and Phase 1 (deferred defects,
     pinned only). Keep the table sorted by id. -->
