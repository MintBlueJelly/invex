ALTER TABLE "documents" ADD COLUMN "document_type" text;
--> statement-breakpoint
-- Canonical schema v1 -> v2 (invoiceNumber/issueDate -> documentNumber/documentDate,
-- plus documentType). Nothing re-validates documents.result on read -- the column
-- is jsonb().$type<CanonicalInvoice>(), a compile-time cast with no runtime parse --
-- so without this backfill every pre-migration row would be served as v1 while
-- TypeScript claimed it was v2. Backfilling keeps exactly one point in history
-- where the shape changes.
--
-- "invoice" is correct by construction for every existing row: it was the only
-- class the pipeline could extract before this migration.
UPDATE "documents"
SET "result" = ("result" - 'invoiceNumber' - 'issueDate')
             || jsonb_build_object(
                  'documentNumber', "result" -> 'invoiceNumber',
                  'documentDate',   "result" -> 'issueDate',
                  'documentType',   'invoice',
                  'schemaVersion',  2
                )
WHERE "result" IS NOT NULL
  AND "result" ->> 'schemaVersion' = '1';
--> statement-breakpoint
-- The candidate envelope nests the same shape one level down.
UPDATE "documents"
SET "candidate" = jsonb_set(
      "candidate",
      '{invoice}',
      (("candidate" -> 'invoice') - 'invoiceNumber' - 'issueDate')
        || jsonb_build_object(
             'documentNumber', "candidate" -> 'invoice' -> 'invoiceNumber',
             'documentDate',   "candidate" -> 'invoice' -> 'issueDate',
             'documentType',   'invoice'
           )
    )
WHERE "candidate" IS NOT NULL
  AND "candidate" -> 'invoice' IS NOT NULL
  AND ("candidate" -> 'invoice' ? 'invoiceNumber' OR "candidate" -> 'invoice' ? 'issueDate');
--> statement-breakpoint
-- fieldMeta is keyed by canonical dotted path, so its keys move too.
UPDATE "documents"
SET "candidate" = jsonb_set(
      "candidate",
      '{fieldMeta}',
      (("candidate" -> 'fieldMeta') - 'invoiceNumber' - 'issueDate')
        || COALESCE(
             CASE WHEN "candidate" -> 'fieldMeta' ? 'invoiceNumber'
                  THEN jsonb_build_object('documentNumber', "candidate" -> 'fieldMeta' -> 'invoiceNumber')
                  ELSE '{}'::jsonb END, '{}'::jsonb)
        || COALESCE(
             CASE WHEN "candidate" -> 'fieldMeta' ? 'issueDate'
                  THEN jsonb_build_object('documentDate', "candidate" -> 'fieldMeta' -> 'issueDate')
                  ELSE '{}'::jsonb END, '{}'::jsonb)
    )
WHERE "candidate" IS NOT NULL
  AND "candidate" -> 'fieldMeta' IS NOT NULL
  AND ("candidate" -> 'fieldMeta' ? 'invoiceNumber' OR "candidate" -> 'fieldMeta' ? 'issueDate');
--> statement-breakpoint
-- Every row that ever committed a result committed an invoice.
UPDATE "documents" SET "document_type" = 'invoice' WHERE "result" IS NOT NULL;
