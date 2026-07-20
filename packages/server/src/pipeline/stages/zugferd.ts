import { parseCiiToEnvelope } from "@invex/core";
import type { StageHandler } from "../machine";
import { emitEvent, getPdf, updateDocument } from "../../db/repos/documents";
import { recordEscalation } from "../../db/repos/escalations";
import { extractZugferdXml } from "../../pdf/zugferdXml";

/**
 * Path A (briefing §2): embedded CII XML → candidate envelope → shared solver.
 * ANY parse/mapping failure degrades gracefully into the text lane — a
 * malformed hybrid must never hard-error.
 */
export const zugferdStage: StageHandler = async (tx, doc, ports) => {
  const pdf = await getPdf(tx, doc.id);
  if (!pdf) throw new Error(`document ${doc.id} has no stored PDF bytes`);

  try {
    const extracted = await extractZugferdXml(pdf);
    if (!extracted) throw new Error("embedded ZUGfERD XML disappeared between triage and parse");
    const envelope = parseCiiToEnvelope(extracted.xml);
    await updateDocument(tx, doc.id, { status: "extracted", candidate: envelope });
    await emitEvent(tx, doc.id, "xml_parsed", {
      attachment: extracted.filename,
      fields: Object.keys(envelope.fieldMeta).length,
      lineItems: envelope.invoice.lineItems?.length ?? 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ports.log.warn({ documentId: doc.id, err: message }, "ZUGfERD parse failed — falling through to text lane");
    await updateDocument(tx, doc.id, { status: "routed", route: "text" });
    await emitEvent(tx, doc.id, "xml_fallthrough", { error: message });
    await recordEscalation(tx, { documentId: doc.id, stage: "xml_fallthrough" });
  }
};
