# Deploying InvEx — the service stack

InvEx is not a single service. This document covers what it needs in order to function, how those
parts relate to each other, how to feed it, and what goes wrong. [README.md](../README.md) covers the
architecture and [api.md](./api.md) the wire contract.

Nothing here prescribes a platform. Run it however you like — the relationships below are what
matter.

## What InvEx needs

| Dependency | Provides | Required |
| --- | --- | --- |
| **Postgres** | every piece of state: documents, results, templates, escalations, the event trace, and the PDF bytes themselves | always |
| **docling-serve** | page-layout analysis and OCR, for the text and image lanes | always |
| **An OpenAI-compatible endpoint** | the vision model behind the VLM escalation | only when the VLM is enabled |

In this reference the third is **LiteLLM**, fronting a **vLLM** instance that serves
**Qwen3.6 35B** — vision-capable, thinking disabled. InvEx addresses it as `doc-vision`.

```
   invex ─────────► docling ──────────┐  layout · OCR
     │                                │
     │ doc-vision                     │ picture description
     ▼                                ▼
   litellm ────────► vllm ────────► Qwen3.6 35B
```

**docling calls the model too.** With remote services enabled, docling captions images during
conversion by calling LiteLLM itself. That is a back-edge: docling is invoked *by* InvEx and then
reaches the model independently, so a single document can arrive at the vision model twice along two
different paths.

## The parts

### invex

- **All state lives in Postgres, including the PDF bytes.** InvEx stores no files of its own.
- **One worker owns the pipeline.** Run a single instance: two would race each other both on the
  queue and on the migrations that run at boot.
- **The VLM is off by default.** `config/pipeline.json` ships `vlm.enabled: false`; set
  `VLM_ENABLED=true` and point `VLM_MODEL` at an alias to enable the escalation path. Without it,
  documents that would escalate go straight to human review.

### docling

- **OCR defaults to a Latin-script model** so German umlauts survive — the upstream default garbles
  them.
- **Remote services must be enabled** for picture description. Without it docling still returns
  layout and OCR; only image captioning is lost.
- **First start downloads its models**, which takes minutes. Until that finishes the text and image
  lanes cannot run.

### litellm

An OpenAI-compatible proxy in front of the model server. It gives InvEx one stable endpoint to talk
to and, more usefully, the **alias** indirection.

Bind to an alias like `doc-vision`, never to a raw model name — the model underneath can then change
without touching InvEx's configuration. `VLM_MODEL` must name an alias; pointing it at a raw model
name is a common cause of rejected escalations.

LiteLLM is not itself a requirement: InvEx needs only something that speaks the OpenAI
chat-completions API, reached via `VLM_URL`, `VLM_MODEL` and optionally `VLM_API_KEY`. It earns its
place here because docling calls the same endpoint, so both consumers share one alias namespace and
one set of credentials.

### vllm

The inference server that actually runs the weights — here Qwen3.6 35B. The escalation path needs a
**vision-capable** model, because by that point the deterministic readers have already failed and what
is left is a rendered image of the page.

A shared model endpoint is a shared resource. If anything else uses the same backend, InvEx's
escalations queue behind it — and an escalation can already take minutes on its own.

## Flows

A client `POST`s a PDF; InvEx stores the bytes and returns immediately. A worker then advances the
document: the text and image lanes call docling for layout and OCR, and if the deterministic path
cannot close the invoice, the document escalates to the vision model through LiteLLM. If that fails
or is unavailable, it lands in human review. Statuses, the polling contract and the five terminal
outcomes are in api.md → [Document lifecycle](./api.md#document-lifecycle).

## Feeding it — the batch consumer pattern

InvEx has no user interface and no intake of its own; feeding it is the consumer's job. The intended
shape is a mail or file poller that ingests attachments and then follows the asynchronous contract:

```
IMAP (PDF attachments) ─► POST /api/ingest        (multipart, N files)
                            └─► 202 [{documentId, deduplicated}]
                                │   deduplicated: already ingested — skip
                                └─► poll GET /api/documents/:id until terminal
                                    ├─ committed          ─► result = canonical invoice
                                    ├─ pending_review     ─► notify a human, then PUT /api/review/:id
                                    ├─ exported_markdown  ─► not an invoice
                                    ├─ segmented          ─► children commit separately (parentId)
                                    └─ failed             ─► error
```

**Ingest is asynchronous.** A consumer written against a synchronous `POST … → result` call will not
work: ingest returns `202` with a document id and nothing else. There is no top-level `decision` or
`confidence` field either — the outcome *is* the document's status.

**Poll patiently.** A VLM escalation can run for minutes; the poller has to tolerate that.

**There is nothing to `INSERT` into.** The canonical invoice lives in InvEx and consumers read it
over the API; the schema belongs to InvEx's migrations. A downstream system that needs its own table
owns that schema and writes it from the API response.

> Wiring up an untrusted intake changes the trust model. Ingest accepts arbitrary bytes and InvEx has
> no authentication of its own, so a poller fed by public email is a materially different exposure
> from a hand-curated folder. Read [Behavior notes](./api.md#behavior-notes) first.

## State

**InvEx's database is the only copy of the PDFs.** There is no volume and no object store — the bytes
live in Postgres alongside the extraction output, together with the results, the learned vendor
templates, the escalation log and the event trace. It is the one place in this stack where data loss
is not recoverable by re-running something. Size and protect it accordingly, and note that
retain-style storage is not a backup.

Everything else is reconstructible: docling's models re-download, and the extraction pipeline is
deterministic given the same inputs.

## Troubleshooting

`{BASE}` is InvEx's base URL, as in [api.md](./api.md).

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Documents pile up in non-terminal statuses while `/health` returns `ok` | the worker is not advancing — `/health` structurally cannot detect this | count documents per non-terminal status, then read that document's trace |
| Everything sits in `escalated_vlm` and drains slowly | the model endpoint is slow, loading, or serving another caller | the document's trace for a `vlm_called` event with no successor |
| `escalated_vlm` → `pending_review` almost immediately, with `vlmAttempted: true` | the endpoint rejected the call: bad credentials, or `VLM_MODEL` is not an alias | the endpoint's own logs distinguish 401 from 400 |
| Text and image lanes fail; `/health` reports `docling: false` | docling is unreachable, or still downloading its models on first start | `/health`, then docling's own startup logs |
| InvEx restarts repeatedly and the oldest non-terminal document never changes | a poison document — see below | the oldest document in a non-terminal status |

```bash
# is the worker advancing?
for s in received routed extracted escalated_vlm; do
  echo -n "$s: "; curl -sf "{BASE}/api/documents?status=$s" | jq 'length'
done

# what happened to one document?
curl -sf {BASE}/api/documents/$ID/trace | jq -r '.events[] | "\(.at) \(.event)"'
```

**The poison-document failure mode** is worth understanding because it is silent. The worker claims
the oldest workable document with `SELECT … FOR UPDATE SKIP LOCKED`, and gives up on a document after
three *caught* stage errors. A document that kills the process instead — an out-of-memory, a hard
crash — rolls the transaction back without incrementing the attempt counter. It therefore never
reaches `failed`, and because claims are ordered oldest-first it is picked up again immediately on
every restart, blocking everything behind it. The fix is to identify the document and remove or
repair it; more memory helps only if memory was the cause.

Two reassurances, both by design: a restart during an in-flight escalation is safe — the row's lock is
released and the document is simply re-claimed — and a database outage stalls nothing permanently,
because the process exits and is restarted until Postgres answers.
