import type { Logger } from "pino";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import type { DocumentRow, Tx } from "../db/repos/documents";
import { claimCondition, claimNext, recordStageError } from "../db/repos/documents";
import type { DocumentStatus, LaneRoute } from "../db/schema";
import type { DoclingPort, VlmPort } from "../ports";

/**
 * In-process pipeline machine (queue-ready by design): stage handlers are
 * idempotent (tx, doc, ports) functions; work is claimed with FOR UPDATE SKIP
 * LOCKED; every stage writes its trace events in the same transaction. Replacing
 * this poll loop with queue consumers later touches only this file.
 */

export interface StagePorts {
  db: Db;
  config: AppConfig;
  log: Logger;
  docling: DoclingPort;
  vlm: VlmPort;
}

export type StageHandler = (tx: Tx, doc: DocumentRow, ports: StagePorts) => Promise<void>;

export interface StageRegistry {
  /** Handlers by status ("received" → route, "extracted" → reconcile, ...). */
  statuses: Partial<Record<Exclude<DocumentStatus, "routed">, StageHandler>>;
  /** Lane handlers for status "routed", keyed by route. */
  lanes: Partial<Record<LaneRoute, StageHandler>>;
}

export interface Machine {
  start(): void;
  stop(): Promise<void>;
  /** Process at most one document; returns whether one was processed. */
  tick(): Promise<boolean>;
  /** Test helper: keep ticking until the pipeline is quiescent. */
  drain(maxTicks?: number): Promise<number>;
}

export function createMachine(ports: StagePorts, registry: StageRegistry): Machine {
  const maxAttempts = ports.config.pipeline.worker.maxAttempts;
  const handledStatuses = Object.keys(registry.statuses) as DocumentStatus[];
  const handledLanes = Object.keys(registry.lanes);
  if (handledLanes.length > 0) handledStatuses.push("routed");
  const condition = claimCondition(handledStatuses, handledLanes, maxAttempts);

  async function tick(): Promise<boolean> {
    let claimedId: string | null = null;
    try {
      return await claimNext(ports.db, condition, async (tx: Tx, doc: DocumentRow) => {
        claimedId = doc.id;
        const handler =
          doc.status === "routed"
            ? registry.lanes[doc.route as LaneRoute]
            : registry.statuses[doc.status as Exclude<DocumentStatus, "routed">];
        if (!handler) {
          throw new Error(`no handler for status=${doc.status} route=${doc.route}`);
        }
        ports.log.debug({ documentId: doc.id, status: doc.status, route: doc.route }, "stage start");
        await handler(tx, doc, ports);
      });
    } catch (err) {
      if (claimedId !== null) {
        ports.log.error({ documentId: claimedId, err }, "stage failed");
        await recordStageError(ports.db, claimedId, err, maxAttempts);
        return true; // counted as processed — attempts moved forward
      }
      throw err; // the claim itself failed (e.g. DB down) — let the loop back off
    }
  }

  let running = false;
  let loopDone: Promise<void> = Promise.resolve();

  function start(): void {
    if (running) return;
    running = true;
    loopDone = (async () => {
      while (running) {
        let processed = false;
        try {
          processed = await tick();
        } catch (err) {
          ports.log.error({ err }, "pipeline tick failed");
        }
        if (!processed) {
          await new Promise((r) => setTimeout(r, ports.config.pipeline.worker.pollIntervalMs));
        }
      }
    })();
  }

  async function stop(): Promise<void> {
    running = false;
    await loopDone;
  }

  async function drain(maxTicks = 1000): Promise<number> {
    let n = 0;
    while (n < maxTicks && (await tick())) n++;
    return n;
  }

  return { start, stop, tick, drain };
}
