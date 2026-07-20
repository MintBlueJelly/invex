import {
  induceTemplate,
  templateIsUseful,
  type CanonicalInvoice,
  type PositionedTextDocument,
} from "@invex/core";
import type { DbOrTx } from "../db/repos/documents";
import { emitEvent } from "../db/repos/documents";
import { upsertTemplate } from "../db/repos/templates";
import type { TemplateSource } from "../db/schema";

/**
 * The briefing's central feedback edge (§1/§6/§7): every VLM extraction, every
 * human-review correction — and optionally every successful rule-engine run —
 * persists a vendor template so the vendor never needs escalation again.
 */
export async function induceAndPersistTemplate(
  db: DbOrTx,
  documentId: string,
  invoice: CanonicalInvoice,
  positionedDoc: PositionedTextDocument,
  source: TemplateSource,
): Promise<{ id: string; version: number; created: boolean } | null> {
  const template = induceTemplate(invoice, positionedDoc);
  if (!templateIsUseful(template)) {
    await emitEvent(db, documentId, "template_induced", {
      source,
      persisted: false,
      reason: "not enough anchors located",
    });
    return null;
  }
  const result = await upsertTemplate(db, template, source);
  await emitEvent(db, documentId, "template_induced", {
    source,
    persisted: true,
    templateId: result.id,
    version: result.version,
    created: result.created,
    fields: Object.keys(template.fields),
    hasLineItemTable: template.lineItemTable !== undefined,
  });
  return result;
}
