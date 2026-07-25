# InvEx — Deterministic-First Invoice Extraction

TypeScript implementation of the InvEx document-ingestion pipeline ([briefing](./docs/briefing.md)).
PDFs go in; **canonical invoice JSON** (header, VAT breakdown, full line items) or **Markdown**
(non-invoices) comes out.

**Design center:** maximize the share of invoices handled by the deterministic CPU path.
The VLM is an escalation, human review the last resort — and **every escalation creates or
updates a vendor template**, so deterministic coverage grows over time (vendor volume is
power-law distributed; recurring vendors have static layouts).

## Pipeline

```
POST /api/ingest ─► triage ───► Path A  zugferd: embedded CII XML ──► solver ─► committed
                     │
                     ├────────► Path B  text: quality gate → segmentation → classifier(3 bands)
                     │                  → template-first extraction (rule engine fills) → solver
                     │                  → committed | markdown | VLM | review
                     │
                     └────────► Path C  image: cheap OCR → vendor IDs → template-on-OCR
                                        (GPU stays cold) | VLM → template induced → committed
```

Every stage writes an append-only event trace (`GET /api/documents/:id/trace`) — the path a
document took is first-class, not reconstructed. The constraint **solver repairs** what
arithmetic over-determination allows (missing qty → 1, unitPrice = lineTotal ÷ qty, single-rate
tax inheritance, VAT synthesis from the closed set 19/7/0 %) and only unresolvable
inconsistencies escalate.

## Layout

| Package             | Contents                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`     | Pure domain, zero I/O: canonical Zod schema, constraint solver, classifier, rule engine + lexicon, template apply/induce (text + OCR), CII parser, Docling mapper, checksums |
| `packages/server`   | Fastify API, Drizzle/Postgres persistence, pipeline worker (`FOR UPDATE SKIP LOCKED`, queue-swappable), Docling/VLM clients, pdf.js triage + rasterizer                      |
| `packages/fixtures` | Synthetic PDF generators (text/ZUGfERD/scanned/garbage) + `expected.json` manifest                                                                                           |

## Prerequisites

| Dependency                                     | Needed for                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node ≥ 24 + pnpm                               | everything (build + all unit/integration tests — integration tests run on in-process **PGlite**, no Docker needed)                                                                      |
| Docker                                         | compose stack (postgres, docling-serve), containerized server                                                                                                                           |
| `docling-serve`                                | Path B layout parsing, Path C OCR (first start downloads models)                                                                                                                        |
| VLM (Ollama/vLLM/llama.cpp, OpenAI-compatible) | escalation path only; **off by default** (enable via `config/pipeline.json` → `vlm.enabled` or env `VLM_ENABLED=true`, plus `VLM_MODEL`) — without it, escalations land in human review |

## Build & test

```bash
pnpm install
pnpm build        # strict typecheck, all packages
pnpm test         # 70+ tests: solver golden tables, checksum vectors, template
                  # fixed-point (induce→apply→reconcile), full pipeline over PGlite
```

## Run

```bash
docker compose up -d postgres docling-serve
cp .env.example .env
pnpm dev                                  # migrates + serves on :8080 + worker loop
```

### E2E recipe

```bash
pnpm fixtures ./out                       # generate sample PDFs + expected.json
pnpm smoke -- ./out --expect ./out/expected.json
```

The smoke harness ingests every PDF, waits for a terminal status and prints one row per
document with the full path taken, e.g.

```
text-invoice.pdf
  8b0c…  committed  gross=1366.95  lines=3
  path: routed:text → gate:ok → classified:invoice(12) → vendor:miss → rules(7) → reconciled:reconciled(4r/0v) → committed → template_induced
```

`--expect` compares route/terminal status/gross/line count/events per file and exits non-zero
on mismatch — also the tool for the classifier-calibration loop once a labeled sample exists.

Drop real PDFs into `fixtures-drop/` and run `pnpm smoke -- ./fixtures-drop` (see its README).

## API

`POST /api/ingest` (multipart) · `GET /api/documents[?status=]` · `GET /api/documents/:id`
(`/pdf`, `/markdown`, `/trace`) · `GET /api/review`, `GET/PUT /api/review/:id` (commit =
invoice **and** template feedback) · `GET /api/templates[/:id]` · `GET /api/escalations` ·
`GET /health`

Full reference — every endpoint with request/response shapes, the canonical invoice schema, all
enums and the behavioral sharp edges: **[docs/api.md](./docs/api.md)**.

Unfamiliar term? **[docs/glossary.md](./docs/glossary.md)** covers the domain, pipeline, AI and testing
vocabulary — and the words that mean something specific in this codebase (`lane`, `band`, `fixture`,
`reconciliation`).

## Deployment

Running InvEx needs Postgres, a docling-serve instance and — for the VLM path — an OpenAI-compatible
endpoint. **[docs/deployment.md](./docs/deployment.md)** covers that service stack: how the parts relate, how to
feed it as a batch consumer, what holds state, and a troubleshooting playbook.

## Config

- `config/pipeline.json` — tolerances, VAT closed set, text-gate thresholds, triage, VLM/worker knobs
- `config/classifier.json` — feature weights + band thresholds (**provisional**; every document's
  feature vector is persisted, so calibrate from real data and adjust — briefing §11)
- `config/prompts/` — per-document-type VLM system prompts
- `.env` — endpoints (`DATABASE_URL`, `DOCLING_URL`, `VLM_URL`, `VLM_MODEL`, `VLM_ENABLED`, `VLM_API_KEY`, `VLM_SCHEMA_MODE`)

## Known open items

- **Classifier band calibration** needs a labeled sample of the real document mix (briefing §11).
- **VLM model/hosting** is settled for the reference deployment (a vision-capable model behind
  LiteLLM — see [docs/deployment.md](./docs/deployment.md)); broader real-model evaluation is still open.
- **Docling response pinning**: the DoclingDocument mapper is tested against hand-authored
  fixtures; capture a live docling-serve response and commit it
  (swap into `packages/server/test/utils/doclingFixtures.ts`). Note the compose file may pin an older
  docling-serve than you run in production — bump both together.
- The compose `app` profile is still unverified; `packages/server/Dockerfile` builds in CI and the
  resulting image runs in the reference deployment.
