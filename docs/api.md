# InvEx HTTP API

Reference for the InvEx server (`@invex/server`). PDFs are ingested asynchronously, run through the
deterministic-first pipeline, and end up either as **canonical invoice JSON** or as **Markdown**;
this document covers every endpoint, the shapes they exchange, and the vocabulary that appears in
them. See [README.md](../README.md) for architecture, configuration and how to run the stack.

## Base URL

```
http://localhost:8080
```

No path prefix and no versioning — routes are absolute (`/api/…` plus `/health`). The port comes
from `PORT` (default `8080`); the server binds `0.0.0.0`. `{BASE}` stands for the base URL in the
examples.

## Transport & limits

| Property | Value |
| --- | --- |
| Authentication / authorization | **none** — see [Behavior notes](#behavior-notes) |
| CORS | not configured (no `Access-Control-*` headers, `OPTIONS` returns 404) |
| Rate limiting | none |
| Request timeout | none (`/health`'s Docling probe has an internal 2 s timeout) |
| JSON request body | max **1 MiB** → `413 FST_ERR_CTP_BODY_TOO_LARGE` |
| Multipart upload | max **100 MiB per file**, **50 files** per request |
| `HEAD` | auto-exposed for every `GET` route (same handler, empty body) |
| Root route / static assets / UI | none — `GET /` is 404 |

## Conventions

- **Money and quantities are strings**, never JSON numbers: `"1366.95"`. This keeps decimal values
  exact and regex-constrainable for schema-guided VLM decoding. Parse to a decimal type, never to a
  float. Values are not zero-padded — a derived unit price may serialize as `"199.5"`.
- **Rates are plain numbers** in percent: `19`, `7`, `0`.
- **Dates** are `YYYY-MM-DD`; **timestamps** are ISO-8601 UTC with a `Z` suffix
  (`"2026-07-25T09:16:41.821Z"`).
- **Ids** are UUIDs. Note that ids are *not* validated before hitting the database — see
  [Behavior notes](#behavior-notes).
- **`fieldMeta` keys are dotted field paths** into the invoice: `totals.gross`,
  `lineItems.2.unitPrice`.
- **Nullable is not the same as optional.** In the canonical invoice every key must be *present*;
  many may be `null`. A missing key is a validation error.
- JSON stored in Postgres `jsonb` (`result`, `candidate`, `repairs`, `violations`, `classifier`,
  `template`, escalation payloads) comes back with **normalized key order**, not the order it was
  written in.

## Errors

Two different error body shapes exist, depending on whether a route handler or Fastify itself
produced the error.

**Handler-authored** — the common case:

```json
{ "error": "not found" }
```

`PUT /api/review/:id` adds an `issues` array for validation failures. `GET /api/documents` puts a
JSON-encoded *string* of Zod issues into `error` (see that endpoint).

**Fastify-generated** — unmatched routes, content-type and body-size rejections, and uncaught
handler exceptions:

```json
{ "statusCode": 415, "code": "FST_ERR_CTP_INVALID_MEDIA_TYPE",
  "error": "Unsupported Media Type", "message": "Unsupported Media Type" }
```

An unmatched route omits `code`: `{"message":"Route GET:/nope not found","error":"Not Found","statusCode":404}`.

| Status | Meaning in this API |
| --- | --- |
| `400` | validation failure (query or body), or an ingest request with no usable file part |
| `404` | no such document/template, no route, or the requested representation does not exist |
| `406` | `POST /api/ingest` received a body Fastify parsed as non-multipart (e.g. `application/json`) |
| `409` | `/api/review/:id` when the document is not `pending_review` |
| `413` | body over 1 MiB, file over 100 MiB, or more than 50 files |
| `415` | content type with no registered parser |
| `500` | unhandled exception — notably a malformed UUID reaching Postgres |

## Document lifecycle

**Ingest is asynchronous. `202` does not mean the document is processed** — it means the bytes were
stored and a row was created with status `received`. A separate worker loop (started alongside the
HTTP server) advances documents through the pipeline. Clients **poll** `GET /api/documents/:id`
until the status is terminal.

| Status | Terminal | Meaning |
| --- | --- | --- |
| `received` | no | bytes stored, not yet triaged |
| `routed` | no | triage done; `route` now decides the lane |
| `extracted` | no | a candidate extraction exists, awaiting the solver |
| `escalated_vlm` | no | queued for the VLM |
| `pending_review` | **yes** | the solver could not close it and no VLM resolved it → human review |
| `committed` | **yes** | `result` holds a valid canonical invoice |
| `exported_markdown` | **yes** | non-invoice output; `markdown` is populated, `result` stays `null` |
| `segmented` | **yes** | multi-invoice PDF; child documents were spawned and commit independently |
| `failed` | **yes** | retries exhausted; `error` holds the last message |

Terminal means the worker will not advance it further. `pending_review` still expects a human to
`PUT` a correction, which moves it to `committed`.

| Route | Path | How it is chosen |
| --- | --- | --- |
| `zugferd` | A | an embedded ZUGfERD/Factur-X/XRechnung XML attachment was found |
| `text` | B | selectable text above the triage threshold |
| `image` | C | little or no selectable text (also reached from B when the text-quality gate says `garbage`) |

`route` is `null` until triage runs.

Polling recipe:

```bash
until curl -sf {BASE}/api/documents/$ID | jq -e '
  .status | IN("committed","exported_markdown","pending_review","failed","segmented")' >/dev/null
do sleep 1; done
```

## Endpoints

### Ingest

#### `POST /api/ingest`

Uploads one or more PDFs and queues them for processing.

**Request** — `multipart/form-data`

| Part | Type | Required | Notes |
| --- | --- | --- | --- |
| any file part | PDF bytes | at least one | The **field name is not checked** — every file part is accepted (`file` is the convention). Non-file parts are ignored, empty files are skipped silently, and the media type is not validated. |

**Response** `202 Accepted` — a JSON **array**, one entry per accepted file, in part order:

```json
[{ "documentId": "a2c7abdc-3bc1-430a-a3f0-9910e8c8719b",
   "filename": "invoice-1.pdf", "deduplicated": false }]
```

| Field | Type | Notes |
| --- | --- | --- |
| `documentId` | uuid | poll this id for progress |
| `filename` | string | as received, or `upload.pdf` when the part carried no filename |
| `deduplicated` | boolean | `true` when an identical PDF already existed; `documentId` is then the **existing** document and nothing is reprocessed |

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{"error":"no PDF file parts in request"}` | no non-empty file part was found |
| `406` | `FST_INVALID_MULTIPART_CONTENT_TYPE` | body parsed as non-multipart (e.g. `application/json`) |
| `413` | `FST_FILES_LIMIT` / `FST_REQ_FILE_TOO_LARGE` | over 50 files, or a file over 100 MiB |
| `415` | `FST_ERR_CTP_INVALID_MEDIA_TYPE` | content type has no parser (e.g. `application/pdf`) |

**Notes**

- Deduplication keys on the SHA-256 of the bytes and ignores `failed` documents, so re-uploading a
  PDF whose previous attempt failed starts a genuinely new document.
- A request that trips the 50-file limit still commits the files processed before it — see
  [Behavior notes](#behavior-notes).

### Documents

#### Document projections

Five endpoints return one of two shapes. **`DocumentSummary`**:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid | |
| `parentId` | uuid \| null | set on children spawned by page segmentation |
| `filename` | string | |
| `status` | string | one of the 9 [statuses](#document-lifecycle) |
| `route` | string \| null | `zugferd` \| `text` \| `image` |
| `segmentPages` | number[] \| null | 1-based pages of this segment within the parent |
| `error` | string \| null | last stage error message |
| `attempts` | number | stage-error count |
| `createdAt` / `updatedAt` | timestamp | |

**`DocumentDetail`** is `DocumentSummary` plus:

| Field | Type | Notes |
| --- | --- | --- |
| `classifier` | object \| null | `{features, score, band}` — see [Classifier](#classifier) |
| `candidate` | object \| null | extraction envelope with provenance — see [Extraction envelope](#extraction-envelope) |
| `result` | object \| null | the [canonical invoice](#canonical-invoice), once `committed` |
| `repairs` | array \| null | what the solver derived — see [Repair rules](#repair-rules) |
| `violations` | array \| null | what it could not close — see [Constraints](#constraints) |
| `vlmAttempted` | boolean | |
| `contentHash` | string | SHA-256 of the PDF bytes |

The PDF bytes, the `markdown` text and the cached positioned-text document are deliberately **not**
included; they have their own endpoints or none.

#### `GET /api/documents`

Lists documents, newest first.

**Request**

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `status` | enum | — | one of the 9 statuses; anything else is a 400 |
| `limit` | integer | `50` | 1–500 |

There is no offset or cursor — `limit` is the only control.

**Response** `200` — array of [`DocumentSummary`](#document-projections):

```json
[{ "id": "8bfc8c58-b354-41ed-93ff-55f1acc21ded", "parentId": null,
   "filename": "invoice-3.pdf", "status": "committed", "route": "text",
   "segmentPages": null, "error": null, "attempts": 0,
   "createdAt": "2026-07-25T09:16:42.761Z", "updatedAt": "2026-07-25T09:16:42.776Z" }]
```

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{"error":"[\n  {\n    \"code\": \"invalid_value\", … }\n]"}` | invalid `status` or `limit` |

**Notes**

- The 400 `error` value is a **JSON-encoded string** containing the pretty-printed Zod issue array,
  not an object — parse it a second time if you need the details. This differs from the review
  endpoint's clean `issues` array.

#### `GET /api/documents/:id`

Returns everything known about one document — the primary polling and result-reading endpoint.

**Request** — no parameters.

**Response** `200` — [`DocumentDetail`](#document-projections). A committed Path B document:

```json
{ "id": "a2c7abdc-3bc1-430a-a3f0-9910e8c8719b", "filename": "invoice-1.pdf",
  "status": "committed", "route": "text", "attempts": 0, "vlmAttempted": false,
  "contentHash": "6e632aa0c80798fca0ef83587e12a997c03fa195add6b17f1e83754522c8d298",
  "classifier": { "band": "invoice", "score": 12, "features": { "F1_headingKeyword": 1, … } },
  "candidate": { "invoice": { … }, "fieldMeta": {
      "issueDate": { "source": "rules", "confidence": 0.65, "rawText": "15.06.2026",
                     "anchor": { "page": 1, "bbox": [0.638, 0.123, 0.878, 0.137] } },
      "totals.net": { "source": "derived", "confidence": 0.45 } } },
  "result": { "schemaVersion": 1, "invoiceNumber": "R-2026-0042",
              "totals": { "net": "1148.70", "tax": "218.25", "gross": "1366.95" }, … },
  "repairs": [ { "rule": "R_NET_FROM_LINES", "path": "totals.net", "to": "1148.70" } ],
  "violations": [],
  "createdAt": "2026-07-25T09:15:22.570Z", "updatedAt": "2026-07-25T09:15:22.662Z" }
```

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"not found"}` | no such document |
| `500` | Fastify error | `:id` is not a valid UUID — see [Behavior notes](#behavior-notes) |

#### `GET /api/documents/:id/pdf`

Returns the originally uploaded PDF bytes.

**Request** — no parameters.

**Response** `200`

| Header | Value |
| --- | --- |
| `Content-Type` | `application/pdf` |
| `Content-Disposition` | `inline` — bare, with no `filename=` parameter |

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"not found"}` | no stored bytes for this id |

#### `GET /api/documents/:id/markdown`

Returns the Markdown export produced for non-invoice documents.

**Request** — no parameters.

**Response** `200` — **JSON**, not `text/markdown`:

```json
{ "documentId": "f6d4300a-395a-47f7-9216-95f7b0d69ed6",
  "classification": "non_invoice",
  "markdown": "# Kündigung\n\nSehr geehrte Damen und Herren, …" }
```

`classification` is the **classifier band** (`invoice` \| `non_invoice` \| `uncertain`), or `null`
when the document was never classified — it is not the reason the Markdown was exported. That reason
lives in the `markdown_exported` trace event.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"not found"}` | no such document |
| `404` | `{"error":"document has no markdown export"}` | document exists but produced no Markdown |

#### `GET /api/documents/:id/trace`

Returns the full append-only event trace — the path the document took through the pipeline.

**Request** — no parameters.

**Response** `200`

```json
{ "document": { … DocumentSummary … },
  "events": [
    { "documentId": "a2c7abdc-…", "event": "routed",
      "detail": { "route": "text", "charCount": 460, "pageCount": 1,
                  "threshold": 50, "pagesScanned": 1 },
      "at": "2026-07-25T09:15:22.578Z" } ] }
```

Events are ordered oldest-first and **include the events of child documents** when the PDF was
segmented, which is why every event carries its own `documentId`. See
[Trace events](#trace-events) for all 19 event names and their `detail` payloads.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"not found"}` | no such document |

### Review

#### `GET /api/review`

Lists the human-review queue: every document in `pending_review`, newest first.

**Request** — no parameters. The status filter and the limit of 100 are fixed.

**Response** `200`

```json
[{ "id": "e3b1c8c5-5a05-4b55-ac2a-9871fbb2a312", "filename": "invoice-1.pdf", "route": "text",
   "vendorGuess": "ACME Bürotechnik GmbH",
   "violationSummary": ["REQUIRED_MISSING","REQUIRED_MISSING","TOTALS_INCOMPLETE",
                        "VAT_MISSING","LINE_ITEMS_MISSING"],
   "createdAt": "2026-07-25T09:16:41.821Z" }]
```

| Field | Type | Notes |
| --- | --- | --- |
| `vendorGuess` | string \| null | the candidate's `seller.name`, if any |
| `violationSummary` | string[] | bare [constraint ids](#constraints); duplicates are kept |

#### `GET /api/review/:id`

Returns one review task: the candidate extraction, why it failed, and where to fetch the PDF.

**Request** — no parameters.

**Response** `200`

```json
{ "id": "e3b1c8c5-…", "filename": "invoice-1.pdf", "route": "text",
  "candidate": { "invoice": { "seller": { "name": "ACME Bürotechnik GmbH",
                                          "ustIdNr": "DE811907980", "ibans": [], … } },
                 "fieldMeta": { "seller.ustIdNr": { "source": "rules", "confidence": 0.9 } } },
  "violations": [ { "constraint": "REQUIRED_MISSING", "paths": ["invoiceNumber"],
                    "detail": "required field invoiceNumber was not extracted" } ],
  "repairs": [],
  "classifier": { "band": "invoice", "score": 7, "features": { … } },
  "pdfUrl": "/api/documents/e3b1c8c5-…/pdf" }
```

`pdfUrl` is a **relative** path, intended for a review UI to load side-by-side with the candidate.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"not found"}` | no such document |
| `409` | `{"error":"document is committed, not pending_review"}` | the document is in any other status |

#### `PUT /api/review/:id`

Commits a human-corrected invoice — and simultaneously creates or updates the vendor template, so
the correction makes the deterministic path smarter for that vendor's next invoice.

**Request** — `application/json`. The body must be a **complete, valid**
[canonical invoice](#canonical-invoice). There are no patch semantics and no envelope wrapper:
every top-level key must be present, `vatBreakdown` and `lineItems` need at least one entry, and
money must be decimal strings. Unknown keys are ignored.

**Response** `200`

```json
{ "documentId": "b62b560a-adc6-4e4c-a3b0-e956b63ee7cf",
  "status": "committed",
  "templateId": "eaa7ecfb-b909-4ab3-9e56-0a2bb3ff49c0" }
```

`templateId` is the created/updated template, or `null` when no template could be induced (the
document had no cached positioned text, or the induced template was too thin to be useful — it needs
at least two header fields or a line-item table).

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"not found"}` | no such document |
| `409` | `{"error":"document is committed, not pending_review"}` | wrong status — also the idempotency guard: replaying a successful commit returns this |
| `400` | `{"error":"invalid canonical invoice","issues":[…]}` | body failed schema validation |
| `422` | `{"error":"corrected invoice does not reconcile","violations":[…]}` | body is schema-valid but its numbers contradict each other |
| `413` | `FST_ERR_CTP_BODY_TOO_LARGE` | body over 1 MiB |

The 400 `issues` entries are `"<path>: <message>"` strings:

```json
{ "error": "invalid canonical invoice",
  "issues": ["invoiceNumber: Too small: expected string to have >=1 characters",
             "issueDate: Invalid input: expected string, received undefined",
             "totals.net: Invalid string: must match pattern /^-?\\d{1,12}(\\.\\d{1,2})?$/",
             "lineItems: Too small: expected array to have >=1 items"] }
```

A 422 body reports only the contradicting constraints, with the same `constraint`/`paths`/`detail`
shape used in `violations` elsewhere:

```json
{ "error": "corrected invoice does not reconcile",
  "violations": [{ "constraint": "C1_TOTALS", "paths": ["totals"],
                   "detail": "net (1000) + tax (190) != gross (999999)" }] }
```

**Notes**

- Checks run in the order 404 → 409 → 400 → 422, so a bad body against a non-`pending_review`
  document reports the 409, not the validation error.
- The commit is one transaction: it sets `status: "committed"` and `result`, clears `violations`,
  emits `review_committed`, induces the template, and stamps the document's escalations as resolved.
- **The solver IS re-run** — the constraint system is the acceptance test for every path, and human
  review is a path. A schema-valid body whose numbers contradict each other is rejected with
  422 and the document stays in `pending_review` — nothing is committed and **no template is
  induced**. That last part is why this gate exists: a template is keyed per vendor and reused, so
  one typo in review would otherwise anchor wrong values for every future invoice from that vendor.
- Only genuine contradictions block: `C1_TOTALS`, `C2_LINE_SUM`, `C3_LINE_MATH`, `C4_VAT_SUM`.
  `C5_VAT_CLOSED_SET` does **not** — it is a DE-specific plausibility heuristic (19/7/0), and a
  reviewer looking at, say, an Austrian 20 % invoice is the authority. A reviewer may assert an
  unusual rate; they may not assert that the totals disagree with each other.
- Values that are missing but derivable are still reconstructed by the solver before the check, so
  a correction that leaves `quantity` null is accepted when the line arithmetic closes without it.
- The committed `result` is the body as submitted, not a solver-rewritten version.

### Templates

#### `GET /api/templates`

Lists stored vendor templates.

**Request**

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer | `100` | clamped to 1–500; a non-numeric value is silently ignored — see [Behavior notes](#behavior-notes) |

**Response** `200` — a projection without the template body:

```json
[{ "id": "cd5cd83d-b734-4b5c-9977-837d50f9e2ac", "ustIdNr": "DE811907980",
   "steuernummer": null, "nameHash": "7b7db46f", "version": 1,
   "source": "rule_engine", "updatedAt": "2026-07-25T09:16:42.746Z",
   "displayName": "ACME Bürotechnik GmbH" }]
```

`source` is `vlm` \| `human_review` \| `rule_engine`. Rows are ordered **oldest-updated first**,
unlike every other list endpoint.

#### `GET /api/templates/:id`

Returns one template including the full template body.

**Request** — no parameters.

**Response** `200` — the stored row; `template` is a [vendor template](#vendor-template):

```json
{ "id": "cd5cd83d-…", "ustIdNr": "DE811907980", "steuernummer": null, "nameHash": "7b7db46f",
  "version": 1, "source": "rule_engine",
  "createdAt": "2026-07-25T09:16:42.746Z", "updatedAt": "2026-07-25T09:16:42.746Z",
  "template": {
    "templateVersion": 1,
    "vendorIds": { "ustIdNr": "DE811907980", "ibans": ["DE02120300000000202051"],
                   "nameHash": "7b7db46f", "displayName": "ACME Bürotechnik GmbH" },
    "locale": { "decimal": ",", "dateFormats": ["dd.MM.yyyy"] },
    "fields": {
      "invoiceNumber": { "label": "Rechnungs-Nr.", "valuePattern": "R-\\d+-\\d+",
                         "region": { "page": 1, "bbox": [0.638, 0.104, 0.878, 0.118] } },
      "totals.gross": { "label": "Gesamtbetrag", "valuePattern": "-?[\\d.,]+",
                        "region": { "page": 1, "bbox": [0.554, 0.750, 0.794, 0.764] } } },
    "lineItemTable": {
      "headerSignature": ["Pos","Bezeichnung","Menge","Einzelpreis","Gesamt"],
      "columns": { "position": 0, "description": 1, "quantity": 2, "unitPrice": 3, "lineTotal": 4 },
      "descriptionContinuation": "rowsWithoutPosNumber" } } }
```

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"not found"}` | no such template |

### Escalations

#### `GET /api/escalations`

Returns the escalation log — the data that drives lexicon and classifier-weight tuning.

**Request**

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `documentId` | uuid | — | filter to one document; an unknown id yields `[]`, a malformed one yields 500 |
| `limit` | integer | `100` | clamped to 1–500; a non-numeric value is silently ignored |

**Response** `200` — raw rows, newest first:

```json
[{ "id": "df5dadb8-5c8f-4ad0-9f3f-ac4009ec1576",
   "documentId": "b62b560a-adc6-4e4c-a3b0-e956b63ee7cf",
   "stage": "vlm_to_review",
   "failedConstraints": [ { "constraint": "REQUIRED_MISSING", "paths": ["invoiceNumber"],
                            "detail": "required field invoiceNumber was not extracted" } ],
   "failedRules": null,
   "classifierFeatures": { "band": "invoice", "score": 7,
                           "features": { "F1_headingKeyword": 1, "F3_taxIdPresent": 1, … } },
   "createdAt": "2026-07-25T09:18:08.606Z",
   "resolvedAt": "2026-07-25T09:18:08.618Z",
   "resolution": "human_review" }]
```

See [Escalation stages](#escalation-stages). `failedRules` is always `null` in the current
implementation, and `resolvedAt`/`resolution` are only ever set by a human review commit.

### Health

#### `GET /health`

Liveness/readiness probe.

**Request** — no parameters.

**Response** `200` — **always**, even when dependencies are down:

```json
{ "status": "ok", "db": true, "docling": false }
```

| Field | Type | Notes |
| --- | --- | --- |
| `status` | string | `"ok"` when the database responds, otherwise `"degraded"` |
| `db` | boolean | a `select 1` succeeded |
| `docling` | boolean | `GET {DOCLING_URL}/health` returned 2xx within 2 s |

`docling: false` does **not** change `status`, and nothing here reports pipeline-worker liveness —
see [Behavior notes](#behavior-notes).

## Worked example

The values below come from the repo's own fixtures. `jq` is used for brevity.

### 1. Ingest

```bash
ID=$(curl -sf -X POST {BASE}/api/ingest \
       -F file=@out/text-invoice.pdf | jq -r '.[0].documentId')
```

```json
[{ "documentId": "a2c7abdc-3bc1-430a-a3f0-9910e8c8719b",
   "filename": "text-invoice.pdf", "deduplicated": false }]
```

### 2. Wait for a terminal status

```bash
until curl -sf {BASE}/api/documents/$ID | jq -e '
  .status | IN("committed","exported_markdown","pending_review","failed","segmented")' >/dev/null
do sleep 1; done
curl -sf {BASE}/api/documents/$ID | jq '{status, route}'
```

```json
{ "status": "committed", "route": "text" }
```

### 3. Read the result

```bash
curl -sf {BASE}/api/documents/$ID | jq '{totals: .result.totals, repairs: [.repairs[].rule]}'
```

```json
{ "totals": { "net": "1148.70", "tax": "218.25", "gross": "1366.95" },
  "repairs": ["R_NET_FROM_LINES","R_VAT_SYNTH","R_LINE_TAX_INHERIT",
              "R_LINE_TAX_INHERIT","R_LINE_TAX_INHERIT"] }
```

The solver derived `totals.net` from the line items and synthesized the VAT breakdown; `violations`
is empty, which is why the document committed without escalating.

### 4. Inspect the path it took

```bash
curl -sf {BASE}/api/documents/$ID/trace | jq -r '.events[] | .event'
```

```
ingested
routed
text_gate
classified
vendor_resolved
rules_applied
reconciled
committed
template_induced
```

`template_induced` is the feedback edge: a template was stored for this vendor. A second invoice
from the same vendor adds a `template_applied` event and its `vendor_resolved` detail gains
`"matchedBy": "ustIdNr"` — the deterministic path now handles that vendor directly.

### 5. When a document lands in review

A vendor whose labels the lexicon does not know escalates instead (with the VLM disabled, the
default):

```bash
curl -sf {BASE}/api/documents/$ID/trace | jq '.events[-1]'
curl -sf {BASE}/api/review | jq '.[0]'
```

```json
{ "event": "escalated",
  "detail": { "to": "human_review", "violations": 5, "vlmAttempted": false } }
```

```json
{ "id": "e3b1c8c5-5a05-4b55-ac2a-9871fbb2a312", "filename": "invoice-1.pdf", "route": "text",
  "vendorGuess": "ACME Bürotechnik GmbH",
  "violationSummary": ["REQUIRED_MISSING","REQUIRED_MISSING","TOTALS_INCOMPLETE",
                       "VAT_MISSING","LINE_ITEMS_MISSING"],
  "createdAt": "2026-07-25T09:16:41.821Z" }
```

### 6. Commit the correction

`GET /api/review/$ID` returns the candidate and `pdfUrl`; the reviewer fixes the values and PUTs a
complete canonical invoice:

```bash
curl -sf -X PUT {BASE}/api/review/$ID \
     -H 'content-type: application/json' -d @corrected-invoice.json
```

```json
{ "documentId": "b62b560a-adc6-4e4c-a3b0-e956b63ee7cf",
  "status": "committed",
  "templateId": "eaa7ecfb-b909-4ab3-9e56-0a2bb3ff49c0" }
```

Replaying that same request now returns `409 {"error":"document is committed, not pending_review"}`.

### 7. Confirm the loop closed

```bash
curl -sf {BASE}/api/templates | jq '.[0] | {source, version, displayName}'
```

```json
{ "source": "human_review", "version": 1, "displayName": "ACME Bürotechnik GmbH" }
```

The document's escalations are now stamped `"resolution": "human_review"`, and the next invoice from
this vendor resolves by `ustIdNr` and extracts deterministically — no escalation, no GPU.

## Reference

### Canonical invoice

The single output contract for every extraction path, returned as `result` and required as the
`PUT /api/review/:id` body. Money matches `^-?\d{1,12}(\.\d{1,2})?$`; `unitPrice` and `quantity`
allow up to 4 decimals; dates are `^\d{4}-\d{2}-\d{2}$`. **Every key must be present**; "nullable"
below means the value may be `null`, not that the key may be omitted.

| Field | Type | Nullable |
| --- | --- | --- |
| `schemaVersion` | `1` (literal) | no |
| `invoiceNumber` | string, non-empty | no |
| `issueDate` | ISO date | no |
| `dueDate` | ISO date | **yes** |
| `currency` | string, exactly 3 chars | no |
| `locale` | string | **yes** |
| `seller` | object, below | no |
| `buyer` | object, below | **yes** |
| `totals` | `{net, tax, gross}`, all money strings | no |
| `vatBreakdown` | array, **min 1** | no |
| `lineItems` | array, **min 1** | no |
| `paymentTerms` | string | **yes** |

`seller` — `name` (string, non-empty, **not** nullable) · `ustIdNr` · `steuernummer` ·
`ibans` (string array, may be empty) · `address`.
`buyer` — `name` · `customerNumber` · `address`, all nullable.
`address` — `street` · `postalCode` · `city` · `countryCode` (2 chars), all nullable.
`vatBreakdown[]` — `rate` (number) · `net` · `tax`, none nullable.

`lineItems[]`:

| Field | Type | Nullable |
| --- | --- | --- |
| `position` | integer | yes |
| `description` | string, non-empty | **no** |
| `quantity` | decimal string (4 dp) | yes |
| `unit` | string | yes |
| `unitPrice` | decimal string (4 dp) | yes |
| `taxRate` | number 0–100 | yes |
| `lineTotal` | money string — **net** semantics | yes |

A complete valid body:

```json
{ "schemaVersion": 1, "invoiceNumber": "R-2026-0042", "issueDate": "2026-06-15",
  "dueDate": null, "currency": "EUR", "locale": null,
  "seller": { "name": "ACME Bürotechnik GmbH", "ustIdNr": "DE811907980",
              "steuernummer": null, "ibans": [], "address": null },
  "buyer": null,
  "totals": { "net": "1148.70", "tax": "218.25", "gross": "1366.95" },
  "vatBreakdown": [ { "rate": 19, "net": "1148.70", "tax": "218.25" } ],
  "lineItems": [
    { "position": 1, "description": "Aktenvernichter PS-500", "quantity": "2", "unit": null,
      "unitPrice": "199.50", "taxRate": 19, "lineTotal": "399.00" },
    { "position": 2, "description": "Wartungsvertrag Bürogeräte, Laufzeit 12 Monate",
      "quantity": "1", "unit": null, "unitPrice": "480.00", "taxRate": 19, "lineTotal": "480.00" },
    { "position": 3, "description": "Toner-Set CMYK", "quantity": "3", "unit": null,
      "unitPrice": "89.90", "taxRate": 19, "lineTotal": "269.70" } ],
  "paymentTerms": null }
```

### Extraction envelope

`candidate` holds the in-progress extraction plus provenance, kept outside the canonical invoice:

```json
{ "invoice": { "…partial canonical invoice…": null },
  "fieldMeta": { "issueDate": { "source": "rules", "confidence": 0.65, "rawText": "15.06.2026",
                                "anchor": { "page": 1, "bbox": [0.638,0.123,0.878,0.137] } } } }
```

`invoice` is a deep-partial canonical invoice — any field may be absent while extraction is
incomplete. `fieldMeta` is keyed by dotted path (`totals.gross`, `lineItems.2`), with:

| Field | Type | Notes |
| --- | --- | --- |
| `source` | string | `zugferd` \| `template` \| `rules` \| `ocr` \| `vlm` \| `human` \| `derived` (`ocr` and `human` are declared but never emitted) |
| `confidence` | number | 0–1 |
| `rawText` | string? | verbatim text before normalization |
| `anchor` | object? | `{page, bbox}`; `page` is 1-based, `bbox` is `[x0,y0,x1,y1]` normalized 0–1 with origin top-left |

### Classifier

```json
{ "band": "invoice", "score": 12,
  "features": { "F1_headingKeyword": 1, "F2_invoiceNumberPattern": 1, "F3_taxIdPresent": 1,
                "F4_labeledInvoiceDate": 1, "F5_vatBreakdownBlock": 1,
                "F6_currencyAmountTable": 1 } }
```

Bands: `invoice` · `non_invoice` · `uncertain`. Features are 0/1. Weights and band thresholds are
**provisional** and configured in `config/classifier.json` (see README).

### Trace events

Every event written by the pipeline, with its `detail` keys.

| Event | When | `detail` |
| --- | --- | --- |
| `ingested` | upload accepted | `filename`, `contentHash`, `bytes` — or `parent`, `pages` on a segmentation child |
| `routed` | triage decided the lane | `route`, `pageCount`, plus `charCount`/`threshold`/`pagesScanned` or `xmlAttachment` |
| `xml_parsed` | Path A parsed the CII XML | `attachment`, `fields`, `lineItems` |
| `xml_fallthrough` | Path A failed → text lane | `error` |
| `text_gate` | text-quality verdict | `verdict` (`ok`\|`garbage`), `dictHitRate`, `cidTokens`, `reasons` |
| `segmented` | multi-invoice PDF split | `segments`, `kinds` |
| `classified` | invoice/non-invoice decision | `band`, `score`, `features` |
| `vendor_resolved` | vendor lookup ran | `extracted` always; `matchedBy`, `templateId`, `version` only on a hit |
| `rules_applied` | rule engine ran | `found`, `missed` |
| `template_applied` | a template was applied | `templateId`, `fieldsHit`, `fieldsMissed`, plus `onOcr` on Path C |
| `vlm_called` | VLM invoked | `model`, `pages` |
| `reconciled` | solver finished | `status`, `repairs`, `violations`, `totalFailure` |
| `committed` | canonical invoice stored | `gross`, `lineCount`, `repairCount` |
| `template_induced` | template induction attempted | `source`, `persisted`; on success `templateId`, `version`, `created`, `fields`, `hasLineItemTable`; on failure `reason` |
| `escalated` | handed to VLM or human | `{to, reason}` \| `{to, violations}` \| `{to, vlmAttempted, violations}` |
| `markdown_exported` | Markdown written | `reason` (`non_invoice` \| `reclassified_total_failure` \| `vlm_non_invoice`) |
| `review_committed` | human commit | `gross`, `lineCount` |
| `stage_error` | a stage threw | `message`, **`attempt`** |
| `failed` | retries exhausted | `message`, **`attempts`** |

### Constraints

Ids appearing in `violations[].constraint` and `violationSummary`.

| Id | Meaning |
| --- | --- |
| `C1_TOTALS` | `net + tax ≠ gross` |
| `C2_LINE_SUM` | line totals do not sum to net |
| `C3_LINE_MATH` | `quantity × unitPrice ≠ lineTotal` |
| `C4_VAT_SUM` | VAT entries do not sum to the tax total |
| `C5_VAT_CLOSED_SET` | a rate outside the accepted set (19/7/0 %) |
| `LINE_TOTAL_UNRESOLVED` | a line total could not be derived |
| `LINE_TAX_UNRESOLVED` | a line tax rate could not be derived |
| `REQUIRED_MISSING` | a required field was not extracted |
| `TOTALS_INCOMPLETE` | totals could not be completed from the extracted amounts |
| `VAT_MISSING` | no VAT breakdown extracted or synthesizable |
| `VAT_INCOMPLETE` | VAT breakdown partially extracted |
| `LINE_ITEMS_MISSING` | no line items extracted |
| `SCHEMA_INVALID` | the assembled invoice failed schema validation |

Violations may carry `delta` and a `hint` (`lines_may_be_gross` — the line totals look like gross
amounts).

### Repair rules

Ids appearing in `repairs[].rule`; each repair also reports the `path` it wrote and the value `to`.

| Id | Derivation |
| --- | --- |
| `R_TOTALS_FROM_VAT` | totals from the VAT breakdown |
| `R_NET_FROM_LINES` | net from the line-item sum |
| `R_TOTAL_DERIVE` | the missing one of net/tax/gross |
| `R_VAT_SYNTH` | a VAT entry synthesized from a closed-set rate |
| `R_LINETOTAL_DERIVE` | `lineTotal = quantity × unitPrice` |
| `R_UNITPRICE_DERIVE` | `unitPrice = lineTotal ÷ quantity` |
| `R_QTY_DERIVE` | `quantity = lineTotal ÷ unitPrice` |
| `R_QTY_DEFAULT` | missing quantity defaulted to 1 |
| `R_LINE_TAX_INHERIT` | line rate inherited from a single-rate document |

### Escalation stages

| Stage | Raised when |
| --- | --- |
| `rules_to_vlm` | uncertain classification, no template on Path C, or the solver failed → VLM |
| `vlm_to_review` | the VLM was unavailable or insufficient → human review |
| `reclassified_markdown` | extraction contradicted itself → exported as Markdown instead |
| `xml_fallthrough` | embedded XML was unusable → text lane |
| `text_gate_reroute` | text layer judged garbage → image lane |

### Vendor template

| Field | Type | Notes |
| --- | --- | --- |
| `templateVersion` | `1` | |
| `vendorIds` | object | `ustIdNr`, `steuernummer`, `ibans`, `nameHash`, `displayName` — all optional |
| `locale` | object | `decimal` (`,` or `.`), `dateFormats` |
| `fields` | object | keyed by `invoiceNumber` \| `issueDate` \| `dueDate` \| `totals.net` \| `totals.tax` \| `totals.gross`; each `{label?, valuePattern?, region?}` |
| `lineItemTable` | object? | `headerSignature`, `columns` (key → **column index**), `descriptionContinuation` (`rowsWithoutPosNumber` \| `indentedRows` \| `none`) |

`region` is `{page, bbox}` with `page` 1-based (`-1` = last page) and a normalized top-left-origin
bbox. Line-item column keys: `position` · `description` · `quantity` · `unit` · `unitPrice` ·
`taxRate` · `lineTotal`.

Vendor resolution tries `ustIdNr`, then `steuernummer`, then any IBAN, then `nameHash`. A re-induced
template **replaces** the body and increments `version`; there is no version history.

## Behavior notes

Verified quirks and sharp edges worth knowing before writing a client.

- **There is no authentication, authorization or CORS.** Anyone who can reach the port can read
  every document and PDF and commit reviews. Do not expose it directly.
- **`/health` is not a pipeline health check.** It always returns `200`; only a database failure
  turns `status` into `"degraded"`, and `docling: false` leaves it `"ok"`. Nothing reports whether
  the **worker loop** is alive, so `{"status":"ok"}` is fully compatible with a server that ingests
  documents and never processes them. Watch for documents stuck in non-terminal statuses instead.
- **A malformed UUID returns `500`, not `404`.** Path ids and `?documentId=` go straight to the
  database, which rejects them (`22P02`). The 500 body may include internal query detail — **do not
  forward it to end users.**
- **`?limit=` on `/api/templates` and `/api/escalations` is not validated.** A non-numeric value
  becomes `NaN`, which is silently ignored and returns **all** rows rather than erroring. Values are
  otherwise clamped to 1–500 (`0` and `-5` both behave as `1`). Only `GET /api/documents` validates
  its query and returns `400`.
- **Two different validation error shapes.** `GET /api/documents` returns `error` as a
  JSON-*encoded string* of Zod issues; `PUT /api/review/:id` returns a clean `issues` array.
- **`/api/templates` is sorted oldest-updated first**, while documents, review and escalations are
  newest-first. Likely unintended; do not rely on it for "recently changed templates".
- **A rejected multi-file upload can still ingest files.** Uploading 51 files returns
  `413 FST_FILES_LIMIT`, but the first 50 are committed and already processing — and the error body
  lists none of their ids. Stay under the limit, or reconcile with `GET /api/documents` afterwards.
- **Duplicate uploads are not an error.** Re-uploading identical bytes returns `202` with
  `deduplicated: true` and the original `documentId`. Only a previously `failed` document's hash is
  re-ingested as new.
- **`PUT /api/review/:id` re-runs the solver** and rejects a self-contradicting body with `422`
  before anything is written; on success it clears `violations` to `[]`. A review-committed invoice
  is therefore both schema-valid and arithmetically consistent — but its VAT rates are *not*
  guaranteed to be in the German closed set, since `C5_VAT_CLOSED_SET` deliberately does not block.
- **`stage_error` reports `detail.attempt`, `failed` reports `detail.attempts`** — singular vs
  plural for the same counter, one event apart.
- **`escalated` has three incompatible `detail` shapes** (see [Trace events](#trace-events));
  reading `detail.reason` yields `undefined` for the two solver-driven variants.
- **`template_induced` does not imply a template exists.** It is also emitted with
  `"persisted": false` and a `reason` when induction found too little to be useful.
- **`resolution` records who closed the document, not who resolved the stage.** A human commit
  stamps `"human_review"` on *every* escalation of that document, including ones a VLM had already
  handled. Escalations resolved automatically by the VLM are never stamped at all, so `resolvedAt`
  stays `null` for them.
- **`failedRules` is always `null`** — nothing populates it yet.
