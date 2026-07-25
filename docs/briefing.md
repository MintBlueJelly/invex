# InvEx — Implementation Briefing

Briefing for implementation planning of "InvEx", a document ingestion pipeline (working title from architecture diagram: "Sovereign AI – Document Ingestion"). This document consolidates the agreed architecture, design decisions, MVP scope cuts, and open items from the design discussion. Treat everything under "Agreed design decisions" as settled; items under "Deferred" are explicitly out of MVP scope.

## 1. System purpose and objectives

The system ingests PDF files and produces one of two outputs:

1. **Invoice documents** → a single canonical JSON schema (header fields, VAT breakdown, and full line items).
2. **Non-invoice documents** → Markdown export for external downstream LLM processing.

Line items are a **first-class requirement**: the use case includes data about invoiced products and services, not just accounting totals. Line-item `description` is mandatory; `quantity`, `unitPrice`, and per-line tax rate are optional and reconstructable (see §4).

**Primary objective:** maximize the share of invoices handled by a deterministic, CPU-bound extraction path. GPU-bound VLM processing is an escalation path only. Human review is the last resort. Every VLM or human-review pass must feed back into the deterministic layer by creating or updating a vendor template — escalations are template-generation events, not just fallbacks. This feedback loop is the mechanism that grows deterministic coverage over time (invoice volume is power-law distributed by vendor; recurring vendors have essentially static layouts).

## 2. Pipeline overview

Every document is UUID-tracked from ingestion. The Ingester routes by content type:

### Path A — Embedded ZUGfERD XML (electronic invoices)

- Parse embedded XML directly to the canonical JSON schema.
- **MVP scope cut:** skip EN 16931 Schematron validation (Mustang/KoSIT). Two cheap exceptions are kept:
  - Malformed or unparseable XML must fail **gracefully into Path B** (text path), never hard-error.
  - The resulting JSON runs through the **same arithmetic validator/reconciler** as all other paths (identical code path, zero extra cost; catches hybrid invoices whose embedded XML is internally inconsistent).

### Path B — Text layer present

1. **Text-quality gate** (new vs. original diagram): heuristic check of the embedded text layer (dictionary hit rate, character-confusion patterns). Garbage text layers from bad upstream OCR are rerouted to Path C.
2. **Page-level segmentation** before classification: handle multi-invoice PDFs and attachment pages (e.g., terms and conditions behind the invoice); otherwise table extraction merges unrelated content.
3. Docling layout parsing (Heron / TableFormer) → DoclingDocument.
4. **Classifier** (weighted feature score, three confidence bands — see §5): invoice / non-invoice / uncertain → uncertain goes to VLM.
5. Invoice: deterministic extraction (template lookup first, generic rule engine second — see §3) → constraint-based reconciliation (see §4).
6. Reconciliation success → JSON output. Failure → rasterize original PDF → VLM with schema-constrained decoding → reconcile again → success: output; failure: human review (PDF vs. JSON side-by-side).
7. Non-invoice: Markdown export.

### Path C — Image-only (scans)

**MVP scope cut:** no generic OCR-based table reconstruction.

1. Cheap CPU OCR (e.g., Tesseract/PaddleOCR via Docling backends) **only to extract vendor identifiers**.
2. If a vendor template exists → apply it directly to the OCR output. Templates use normalized positional anchors, so template-based line-item extraction on OCR output is feasible even where generic extraction is not.
3. If no template exists → VLM parses and classifies; the result is persisted as a new vendor template.
4. VLM-classified non-invoices route back to Markdown output.

Deferred middle tier for later: Docling TableFormer runs on rasterized pages and could sit between cheap OCR and full VLM if GPU load becomes a problem. Do not build in MVP.

## 3. Vendor template system (core deterministic mechanism)

### Vendor identification

Composite key with priority order; store **all** observed identifiers in the template so any one resolves the vendor later:

1. USt-IdNr (checksum-verifiable, most stable)
2. Steuernummer (covers Kleinunternehmer without USt-IdNr)
3. IBAN (checksum-verifiable, but changes with bank switches; vendors may print several)
4. Normalized vendor name + postal code hash (last resort)

### Template structure

One **canonical schema for all vendors**. Templates map canonical fields to vendor-specific extraction descriptors — never vendor-specific schemas. Verbatim labels alone are insufficient (labels repeat on a page; some fields are unlabeled), so each descriptor combines multiple anchor types:

```json
{
  "vendorIds": { "ustIdNr": "DE123456789", "ibans": ["DE89..."] },
  "locale": { "decimal": ",", "dateFormats": ["dd.MM.yyyy"] },
  "fields": {
    "invoiceNumber": {
      "label": "Rechnungs-Nr.",
      "valuePattern": "R-\\d{6}",
      "region": { "page": 1, "bbox": [0.55, 0.1, 0.95, 0.25] }
    },
    "grandTotal": {
      "label": "Gesamtbetrag",
      "region": { "page": -1, "bbox": [0.5, 0.6, 1.0, 0.9] }
    }
  },
  "lineItemTable": {
    "headerSignature": ["Pos", "Artikel", "Anzahl", "Einzelpreis", "Summe"],
    "columns": {
      "quantity": 2,
      "description": 1,
      "unitPrice": 3,
      "lineTotal": 4
    },
    "descriptionContinuation": "rowsWithoutPosNumber"
  }
}
```

Design notes:

- `headerSignature` disambiguates the correct table when a page contains several.
- Column mapping is **by index after table match**, which is more robust than per-cell labels.
- `descriptionContinuation` handles multi-row descriptions — the most common line-item failure mode.
- `region` bboxes use **normalized coordinates** so the same template works on text-layer and OCR output.
- Templates are created/updated from three sources: VLM extraction results, human-review corrections, and (optionally) successful generic-rule-engine runs.

### Generic rule engine (template-less first attempt, Path B only)

For first-seen vendors with a text layer:

- Label-anchor matching against a multilingual synonym lexicon (Rechnungsnummer/Invoice No./Beleg-Nr.; Gesamtbetrag/Total/Summe; etc.)
- Locale-aware number parsing (1.234,56 vs. 1,234.56) and date normalization
- Table-column classification by header synonyms on TableFormer output

## 4. Constraint-based reconciliation (validator = repair step)

The validator operates on the **final canonical JSON**, and parser and validator effectively merge: extraction produces candidate fields, a constraint solver reconciles them, and only unresolvable inconsistencies escalate. This is the mechanism that absorbs structural variation across invoices (missing quantities, unit prices, per-line tax rates).

Invoices are arithmetically over-determined. Exploit these constraints:

- net + tax = gross
- Σ(line totals) = subtotal
- quantity × unit price = line total (per line)
- German VAT rates come from a small closed set (19 %, 7 %, 0 %)

Repair rules for optional fields:

- Missing quantity → default 1, verified via unit price × 1 = line total
- Missing unit price → derived as line total ÷ quantity
- Missing per-line tax rate → inherited from the document-level VAT breakdown, cross-checked against the tax sum

If the constraint system closes consistently, the extraction is accepted even though fields were inferred. Total reconciliation failure across a document is also a **reclassification signal** (see §5).

## 5. Classifier (MVP: weighted feature score, no trained model)

Deterministic invoice signals, each with a weight:

- "Rechnung"/"Invoice" in a heading position
- Invoice-number pattern present
- USt-IdNr or Steuernummer present
- Date labeled as invoice date
- VAT breakdown block present
- ≥1 table containing currency amounts

Sum weights → three bands, thresholds calibrated **empirically on a labeled sample of the real document mix**:

- Clearly invoice → deterministic pipeline
- Clearly non-invoice → Markdown export
- Uncertain (middle band) → VLM classification

Robustness additions:

- A document classified as invoice in which **no amounts reconcile at all** is rerouted to the Markdown path instead of human review (probable misclassification).
- Log the full feature vector on every escalation; adjust weights from evidence.
- Later (post-MVP): replace with a small calibrated classifier trained on the labels this process generates for free.

## 6. VLM integration

- Use **constrained decoding against the canonical JSON schema** (vLLM and llama.cpp both support schema-guided generation). Schema validity is then guaranteed by construction; only arithmetic validity remains to be checked by the reconciler.
- Per-document-type system prompts (per original diagram).
- Every successful VLM extraction persists a new vendor template (field mapping + positional anchors) so the vendor never requires the GPU again.
- Pre-classifier for junk filtering before VLM (per diagram) remains optional, dependent on junk volume and GPU contention.

## 7. Human review

- Input: original PDF side-by-side with candidate JSON.
- Output: corrected JSON → invoice output **and** template create/update. The original diagram had corrections flowing only to output; the template feedback edge is a required fix.
- UI priority: fast correction of **line-item column mappings and continuation rules**, because that correction converts a one-off extraction into a durable template. Header-field correction is secondary.

## 8. Observability requirements

- UUID tracking end to end (per diagram).
- On every escalation (rule engine → VLM, VLM → human review), log **which constraint or rule failed** plus the classifier feature vector. This data prioritizes lexicon/rule additions and weight tuning.

## 9. Deferred / out of MVP scope

- EN 16931 Schematron validation for ZUGfERD (Mustang/KoSIT) — except graceful XML failure and shared arithmetic validation, which are in scope.
- Generic OCR table reconstruction on Path C.
- TableFormer-on-raster middle tier between OCR and VLM.
- Trained ML classifier (feature-score classifier ships first).

## 10. Suggested build order

1. Canonical JSON schema + arithmetic reconciliation solver (everything depends on these; the solver doubles as the validator on all paths).
2. Ingester routing (XML / text / image detection) + UUID tracking.
3. ZUGfERD path: XML parser → canonical JSON → shared reconciler; graceful degradation to text path.
4. Template store + composite vendor-ID resolution.
5. Path B: text-quality gate, page segmentation, Docling integration, generic rule engine, template application.
6. Classifier feature score + band calibration (requires a labeled sample — see open items).
7. VLM integration with schema-constrained decoding + template persistence from VLM output.
8. Path C: OCR identifier extraction + template application on OCR output.
9. Human-review workflow with template feedback loop.
10. Escalation logging + reporting.

## 11. Open items requiring user input or data

- A labeled sample of the real document mix is needed to calibrate classifier bands (§5).
- Verify the power-law vendor distribution assumption against actual volume once ingestion runs; it drives the expected ROI of the template system.
- VLM model choice and hosting (`<Model>` placeholder in diagram) is undecided.
- Canonical JSON schema field list must be finalized before step 1; agreed constraints so far: line-item `description` mandatory; `quantity`, `unitPrice`, per-line tax optional and solver-reconstructable.
