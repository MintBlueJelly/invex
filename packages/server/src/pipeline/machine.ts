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
  /**
   * Injectable delay, defaulting to setTimeout. The retry SCHEDULE is otherwise
   * unobservable — it lives inside a bare timer closed over by the loop — and a
   * backoff nobody can assert on is a backoff that silently regresses.
   */
  sleep?: (ms: number) => Promise<void>;
}

export type StageHandler = (tx: Tx, doc: DocumentRow, ports: StagePorts) => Promise<void>;

export interface StageRegistry {
  /** Handlers by status ("received" → route, "extracted" → reconcile, ...). */
  statuses: Partial<Record<Exclude<DocumentStatus, "routed">, StageHandler>>;
  /** Lane handlers for status "routed", keyed by route. */
  lanes: Partial<Record<LaneRoute, StageHandler>>;
}

/**
 * What /health needs to answer "is the worker alive?".
 *
 * The probe could not answer it before, so `{"status":"ok"}` was fully
 * compatible with a server that ingests documents and never processes one —
 * the exact failure DEPLOYMENT.md lists first in its troubleshooting table and
 * describes as structurally undetectable (INVEX-009).
 */
export interface MachineHealth {
  /** The poll loop is active. */
  running: boolean;
  /** Epoch ms of the last completed tick. Refreshes every poll while idle. */
  lastTickAt: number | null;
  /** Epoch ms the in-flight tick started, or null when idle. */
  inFlightSince: number | null;
}

export interface Machine {
  start(): void;
  stop(): Promise<void>;
  /** Process at most one document; returns whether one was processed. */
  tick(): Promise<boolean>;
  /** Test helper: keep ticking until the pipeline is quiescent. */
  drain(maxTicks?: number): Promise<number>;
  health(): MachineHealth;
}

export function createMachine(ports: StagePorts, registry: StageRegistry): Machine {
  const maxAttempts = ports.config.pipeline.worker.maxAttempts;
  const handledStatuses = Object.keys(registry.statuses) as DocumentStatus[];
  const handledLanes = Object.keys(registry.lanes);
  if (handledLanes.length > 0) handledStatuses.push("routed");
  const condition = claimCondition(handledStatuses, handledLanes, maxAttempts);
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastTickAt: number | null = null;
  let inFlightSince: number | null = null;

  /**
   * "idle"      — nothing claimable.
   * "processed" — a document was claimed and advanced.
   * "errored"   — a document was claimed and its stage threw.
   *
   * The distinction exists because the loop must back off after an error while
   * drain() must still treat it as work to continue past.
   */
  type TickOutcome = "idle" | "processed" | "errored";

  async function runTick(): Promise<TickOutcome> {
    inFlightSince = Date.now();
    try {
      let claimedId: string | null = null;
      try {
        const claimed = await claimNext(ports.db, condition, async (tx: Tx, doc: DocumentRow) => {
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
        return claimed ? "processed" : "idle";
      } catch (err) {
        if (claimedId !== null) {
          ports.log.error({ documentId: claimedId, err }, "stage failed");
          await recordStageError(ports.db, claimedId, err, maxAttempts);
          return "errored";
        }
        throw err; // the claim itself failed (e.g. DB down) — let the loop back off
      }
    } finally {
      inFlightSince = null;
      lastTickAt = Date.now();
    }
  }

  async function tick(): Promise<boolean> {
    return (await runTick()) !== "idle";
  }

  let running = false;
  let loopDone: Promise<void> = Promise.resolve();

  function start(): void {
    if (running) return;
    running = true;
    loopDone = (async () => {
      while (running) {
        let outcome: TickOutcome = "idle";
        try {
          outcome = await runTick();
        } catch (err) {
          ports.log.error({ err }, "pipeline tick failed");
        }
        // Sleep after an error as well as when idle. Skipping the sleep meant
        // the next tick re-claimed the SAME document immediately — claims are
        // ordered oldest-first and it is still under maxAttempts — so all three
        // attempts burned within a few hundred milliseconds. One docling restart
        // or one llama-swap 503 during a cold model load, both routine, would
        // permanently fail every in-flight document (INVEX-007).
        if (outcome !== "processed") {
          await sleep(ports.config.pipeline.worker.pollIntervalMs);
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

  function health(): MachineHealth {
    return { running, lastTickAt, inFlightSince };
  }

  return { start, stop, tick, drain, health };
}
