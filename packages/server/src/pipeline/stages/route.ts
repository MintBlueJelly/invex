import type { StageHandler } from "../machine";
import { emitEvent, getPdf, updateDocument } from "../../db/repos/documents";
import { triagePdf } from "../../pdf/triage";

/** received → routed: content-type triage (briefing §2). */
export const routeStage: StageHandler = async (tx, doc, ports) => {
  const pdf = await getPdf(tx, doc.id);
  if (!pdf) throw new Error(`document ${doc.id} has no stored PDF bytes`);

  const outcome = await triagePdf(pdf, ports.config.pipeline.triage);
  await updateDocument(tx, doc.id, { status: "routed", route: outcome.route });
  await emitEvent(tx, doc.id, "routed", {
    route: outcome.route,
    pageCount: outcome.pageCount,
    ...outcome.reason,
  });
};
