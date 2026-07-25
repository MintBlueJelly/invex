# fixtures-drop

Drop **real** invoice PDFs here. Everything in this folder except this README is
gitignored, so nothing confidential is committed by accident.

Real documents are the point. The lexicon, the segmentation heuristics, the
classifier bands and template induction were all tuned on synthetic fixtures
(briefing §11 and the repo's status notes say so), and no synthetic corpus can
tell you what your actual vendor mix looks like.

## 1. See what the pipeline does with them

With the stack running (`docker compose up -d postgres docling-serve`, `pnpm dev`):

```bash
pnpm smoke -- ./fixtures-drop
```

One row per document with the full path it took. When something escalates,
`GET /api/escalations?documentId=…` names the constraint or rule that failed —
that is the thing worth fixing, and it is the data briefing §8 exists to produce.

## 2. Turn a document into a permanent regression test

```bash
pnpm fixtures:label ./fixtures-drop/acme-2026-001.pdf
```

This ingests the PDF, waits for a terminal status, and writes
`packages/fixtures/scenarios/real-NNNN.golden.json` containing the pipeline's
**own output** as `draftCanonical`, marked `reviewed: false`.

**A draft is not an expectation.** Read the PDF, correct every field, move
`draftCanonical` to `expected.canonical`, and set `reviewed: true`. Until you do,
`goldenPurity.test.ts` requires `expected.canonical` to stay `null` — a draft used
as an oracle would assert only that the pipeline agrees with itself, which is
precisely the flaw the golden corpus replaced.

Once reviewed, `goldenConsistency.test.ts` enforces that your corrections are
arithmetically sound (net + VAT = gross, lines sum to the subtotal, and so on),
so a slip in the correction is caught rather than baked in.

## 3. Check the whole corpus end to end

```bash
pnpm fixtures ./out
pnpm smoke -- ./out --expect ./out/expected.json --strict-canonical
```

`--strict-canonical` compares the committed canonical invoice **field by field**
against what the pipeline produced, reporting the exact path of any difference.
Without it the harness checks the gross total and the line *count* only — every
description, unit price and VAT row goes unverified, which is how a
wrong-but-plausible extraction passes a smoke run.

## Why this loop matters

Label enough real documents this way and two open items close themselves: the
classifier band calibration finally has the labeled sample briefing §11 asks for,
and the corpus stops being a guess about German invoices and becomes a record of
yours.
