# InvEx — agent brief

Deterministic-first PDF document extraction. PDFs go in; **canonical JSON** (header, VAT breakdown,
full line items) or **Markdown** (everything else) comes out.

Read [README.md](./README.md) first — it has the pipeline diagram, the package table and the run
recipes. This file covers only what is *not* written down elsewhere: the conventions you will violate
by accident.

## Where the knowledge lives

| Need | Read |
| --- | --- |
| Architecture, pipeline, run/E2E recipes | [README.md](./README.md) |
| Why a design is the way it is | [docs/briefing.md](./docs/briefing.md) — source comments cite it as `briefing §N`; the section numbers are load-bearing |
| Wire contract, canonical schema, every enum | [docs/api.md](./docs/api.md) |
| A word you are unsure of | [docs/glossary.md](./docs/glossary.md) — `band`, `lane`, `fixture`, `reconciliation` and `template` each mean two things here |
| Operations, service stack, severity context | [docs/deployment.md](./docs/deployment.md) |
| Known defects and the code review | [docs/known-bugs.md](./docs/known-bugs.md), [docs/review.md](./docs/review.md) |
| Non-engineer orientation | [docs/about.md](./docs/about.md) |

## Commands

```bash
pnpm install
pnpm build        # typecheck ONLY — see below
pnpm test         # unit + prop + component + integration + e2e
pnpm test:cov     # with the coverage ratchet
pnpm dev          # migrate + serve :8080 + worker loop
```

**`pnpm build` compiles nothing.** It is `tsc --noEmit` across the workspace. Every package's `exports`
points at raw `src/*.ts` and the runtime is `tsx`. There is no `dist/`, and "the build is broken" always
means a type error.

**There is no linter and no formatter.** No ESLint, Prettier, Biome, or `.editorconfig`. Do not add one
uninvited; match the surrounding file instead.

## Running one test file

Six vitest lanes are defined in `vitest.config.ts`: `unit`, `prop`, `component`, `integration`, `e2e`,
`pg`. A file only runs in the lane whose include glob it matches:

```bash
pnpm vitest run --project unit packages/core/test/unit/parsing/amounts.test.ts
pnpm vitest run --project component -t "health"
```

> **Every project sets `passWithNoTests: true`.** Naming the wrong `--project` reports success having
> run nothing. If a change "passes" suspiciously fast, check the test count.

**The component lane runs its files serially, on purpose.** Each of its tests gets a real PGlite
instance, and spinning one up is the slow part. With files in parallel at a 30 s limit the lane failed
intermittently under a full `pnpm test` — `Test timed out in 30000ms`, in a *different* file each run
(harness, health, ingest, review.arithmetic, templates.integrity), i.e. whichever fork lost the race,
never a test related to the change in hand. It reproduced on an unmodified tree, so it was never
anybody's edit.

Fixed by matching `integration`'s budgets (60 s / 120 s) and setting `fileParallelism: false`, as `e2e`
and `pg` already do — that caps concurrent PGlite instances at one per lane instead of one per core,
which is what the timeouts were actually about. Verified over five consecutive full runs (three
`pnpm test`, two `pnpm test:cov`), all green, at no wall-clock cost.

If you see a component timeout again, suspect machine load rather than your change, and re-run the lane
alone (`pnpm test:component`) to confirm. Do not "fix" it by re-enabling file parallelism.

## Conventions that are easy to break

- **Money is decimal strings** (`"1366.95"`), never floats, with `decimal.js` for arithmetic. Tolerances
  in `config/pipeline.json` are strings too. A float anywhere in the money path is a bug.
- **`packages/core` is I/O-free** and compiled with `"types": []` — no Node globals, no `fs`, no
  `structuredClone`. Anything that touches the outside world belongs in `packages/server`.
- **`verbatimModuleSyntax`** is on: `import type` / `export type` must be explicit. ESM throughout,
  relative imports are extensionless, and there are no path aliases.
- **`noUncheckedIndexedAccess`** is on: `arr[0]` is `T | undefined`.
- **Comments explain *why*** and cite `briefing §N` or an `INVEX-nnn` id. The density is deliberate —
  match it. A comment restating the code is noise; one recording a decision is the point.
- **`config/prompts/*.md` are runtime assets, not docs.** `.dockerignore` and the CI path filter both
  carry warnings about this: `*.md` exclusions must stay root-level and never become `**/*.md`.

## The known-bug protocol

A defect that is not being fixed is pinned in code, not filed in a wiki:

```ts
knownBug("INVEX-042", "short summary").it("describes the CORRECT behaviour", () => { ... });
```

It is backed by `it.fails()` (`test-utils/knownBug.ts`), so it **passes while the bug is live and goes
red the moment the bug is fixed**. Consequences:

- Fixing a bug means promoting its pin to a plain `it` **and** flipping its row in
  `docs/known-bugs.md` — in the same commit. `packages/server/test/unit/knownBugs.registry.test.ts`
  fails if the table and the tests disagree about which ids exist.
- Every pin is paired with a plain `[current]` test recording what the code does today, so a change to
  some *third* wrong behaviour is still noticed.
- `pnpm test:known-bugs` is **expected to be red**. That red is the report, not a failure. What matters
  is that no *new* pin appears and none flips silently.
- Highest id in use: **INVEX-059**. Allocate upward.

## Test fixtures: goldens are an oracle

`packages/fixtures/scenarios/*.golden.json` each hold two **independently authored** halves: `render.doc`
is the literal ink on the page (`"1.148,70"`, `"15.06.2026"`) and `expected.canonical` is the document a
competent human reading that page would type (`"1148.70"`, `"2026-06-15"`). The pipeline is the only
thing claiming to connect them — that is what makes them an oracle rather than an echo.

- **Never regenerate a golden from pipeline output.** The suite this replaced did exactly that and could
  only ever prove the code agreed with itself (see [docs/review.md](./docs/review.md)).
- A `reviewed: false` draft may not serve as an expectation; `goldenPurity.test.ts` enforces it.
- Relaxing a guard in `goldenConsistency.test.ts` is how an oracle quietly stops being one. If you must,
  pair the relaxation with a compensating assertion.

## Document classes

The canonical schema is v2 and carries a `documentType`: `invoice`, `creditNote`, `orderConfirmation`,
`deliveryNote`, `quote`. Three things are commonly confused:

- **`committed` does not mean the arithmetic was checked.** `arithmeticVerified` on the document says
  whether the numbers actually corroborated each other, judged pre-repair. False on a committed document
  means there was nothing to check (a priceless Lieferschein), not that a check failed; null means the
  row predates the flag. `?status=committed&arithmeticVerified=true` is the query that means what
  `committed` used to.
- **`classifier.band` is a confidence bucket** (`invoice` / `non_invoice` / `uncertain`) — how sure the
  weighted score is. **`documentType` is the class** — which document it is. Deliberately orthogonal
  axes; do not collapse them.
- **`TemplateFieldKey` and the lexicon's header keys did NOT follow the v2 rename.** They are template
  vocabulary (`invoiceNumber`, `issueDate`) and map to canonical paths (`documentNumber`,
  `documentDate`) in `template/apply.ts setField` / `canonicalPathFor`. `fieldMeta` is keyed by the
  **canonical** path. Renaming one to match the other means a jsonb migration for every persisted
  template.

`reconcile/profiles.ts` says which classes must carry amounts. Constraints C1–C5 always run for every
class — they self-gate on evaluability, so a priceless Lieferschein produces no violations without a
single extra branch, and one that *does* print prices is validated identically to an invoice.

## Windows

`test:prop:deep` and `test:known-bugs` use POSIX `VAR=value cmd` prefixes and fail in PowerShell. Run
them from Git Bash, or set the variable separately.

## Coverage

Thresholds in `vitest.config.ts`: lines 96, statements 93, functions 95, branches 83. The rule in the
config is "raise at each phase boundary; never lower." Measure with `pnpm test:cov` before finishing.
