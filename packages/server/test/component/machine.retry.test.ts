import { documents } from "../../src/db/schema";
import { createMachine, type StagePorts } from "../../src/pipeline/machine";
import { crashingStage, flakyStage } from "../utils/doubles";
import { describe, expect, it } from "../utils/fixture";
import { seedDocument } from "../utils/testEnv";
import { getTrace } from "../../src/db/repos/documents";
import { eq } from "drizzle-orm";

/**
 * INVEX-007 — retry pacing.
 *
 * A stage error used to return "processed", which skipped the loop's poll
 * sleep. Claims are ordered oldest-first and the document is still under
 * maxAttempts, so the next tick re-claimed the SAME row immediately: all three
 * attempts burned within a few hundred milliseconds. One docling restart, or
 * one llama-swap 503 during a cold model load — both routine per docs/deployment.md
 * — therefore drove every in-flight document to `failed` permanently.
 */

function machineWith(env: { db: unknown; config: unknown; ports: StagePorts }, stage: unknown, sleeps: number[]) {
  const ports: StagePorts = {
    ...env.ports,
    sleep: (ms: number) => {
      sleeps.push(ms);
      // Must yield to the MACROtask queue. Resolving immediately keeps the loop
      // in a microtask chain that starves the test's own timers — the loop spins
      // forever and stop() never gets a turn.
      return new Promise<void>((r) => setTimeout(r, 0));
    },
  };
  return createMachine(ports, {
    statuses: { received: stage as never },
    lanes: {},
  });
}

describe("retry pacing", () => {
  it("sleeps BETWEEN attempts instead of burning them back to back", async ({ env }) => {
    await seedDocument(env.db, { status: "received" });

    // One interleaved log, so the assertion is about ORDER, not counts. Counting
    // sleeps alone would pass even with the old code, because the idle ticks
    // after the document reaches `failed` also sleep.
    const log: string[] = [];
    const ports: StagePorts = {
      ...env.ports,
      sleep: (ms) => {
        log.push(`sleep:${ms}`);
        return new Promise<void>((r) => setTimeout(r, 0));
      },
    };
    const machine = createMachine(ports, {
      statuses: {
        received: () => {
          log.push("attempt");
          return Promise.reject(new Error("docling unavailable"));
        },
      },
      lanes: {},
    });

    machine.start();
    for (let i = 0; i < 100 && log.filter((l) => l === "attempt").length < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await machine.stop();

    const pollMs = env.config.pipeline.worker.pollIntervalMs;
    const upToLastAttempt = log.slice(0, log.lastIndexOf("attempt") + 1);
    // Exactly: attempt, sleep, attempt, sleep, attempt. The old code produced
    // "attempt, attempt, attempt" — all three burned in one event-loop burst.
    expect(upToLastAttempt).toEqual(["attempt", `sleep:${pollMs}`, "attempt", `sleep:${pollMs}`, "attempt"]);
  });

  it("still reaches failed after maxAttempts", async ({ env }) => {
    const id = await seedDocument(env.db, { status: "received" });
    const sleeps: number[] = [];
    const machine = machineWith(env, crashingStage(new Error("boom")), sleeps);

    for (let i = 0; i < 5; i++) await machine.tick();

    const [row] = await env.db.select().from(documents).where(eq(documents.id, id));
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(env.config.pipeline.worker.maxAttempts);
  });

  it("emits stage_error per attempt and failed exactly once", async ({ env }) => {
    const id = await seedDocument(env.db, { status: "received" });
    const machine = machineWith(env, crashingStage(new Error("boom")), []);
    for (let i = 0; i < 5; i++) await machine.tick();

    const events = (await getTrace(env.db, id)).map((e) => e.event);
    expect(events.filter((e) => e === "stage_error")).toHaveLength(3);
    expect(events.filter((e) => e === "failed")).toHaveLength(1);
  });

  it("a transient failure still succeeds on a later attempt", async ({ env }) => {
    const id = await seedDocument(env.db, { status: "received" });
    const stage = flakyStage(1, async (tx, doc) => {
      await tx.update(documents).set({ status: "committed" }).where(eq(documents.id, doc.id));
    });
    const machine = machineWith(env, stage, []);

    await machine.tick();
    await machine.tick();

    const [row] = await env.db.select().from(documents).where(eq(documents.id, id));
    expect(row!.status).toBe("committed");
  });

  it("a failed document is no longer claimable", async ({ env }) => {
    await seedDocument(env.db, { status: "received" });
    const machine = machineWith(env, crashingStage(new Error("boom")), []);
    for (let i = 0; i < 5; i++) await machine.tick();

    expect(await machine.tick()).toBe(false);
  });
});

describe("worker liveness", () => {
  it("reports not running before start", async ({ env }) => {
    expect(env.machine.health().running).toBe(false);
  });

  it("reports running and a recent tick while the loop is alive", async ({ env }) => {
    env.machine.start();
    await new Promise((r) => setTimeout(r, 50));
    const h = env.machine.health();
    await env.machine.stop();

    expect(h.running).toBe(true);
    expect(h.lastTickAt).not.toBeNull();
    expect(Date.now() - h.lastTickAt!).toBeLessThan(5_000);
  });
});
