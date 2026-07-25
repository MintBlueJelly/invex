import { buildApp } from "../../../src/http/app";
import type { MachineHealth } from "../../../src/pipeline/machine";
import { describe, expect, it } from "../../utils/fixture";
import { testConfig } from "../../utils/testEnv";

/**
 * INVEX-009 — /health could not report an unhealthy service.
 *
 * It always returned HTTP 200, so a Kubernetes probe never failed, and it said
 * nothing about the worker. DEPLOYMENT.md lists "documents pile up in
 * non-terminal statuses while /health returns ok" as its FIRST troubleshooting
 * row and notes the probes structurally cannot detect it. With one replica and
 * a Recreate strategy, that is the difference between a self-healing restart
 * and a queue that stays wedged until someone notices.
 */

function appWith(env: { db: Parameters<typeof buildApp>[0]["db"] }, worker: () => MachineHealth) {
  return buildApp({ db: env.db, config: testConfig(), worker });
}

const alive: MachineHealth = { running: true, lastTickAt: Date.now(), inFlightSince: null };

describe("GET /health", () => {
  it("returns 200 and ok when the database and worker are healthy", async ({ env }) => {
    const app = appWith(env, () => ({ ...alive, lastTickAt: Date.now() }));
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", db: true, worker: { ok: true, running: true } });
  });

  it("returns 503 when the worker loop is not running", async ({ env }) => {
    const app = appWith(env, () => ({ running: false, lastTickAt: Date.now(), inFlightSince: null }));
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "degraded", worker: { ok: false, running: false } });
  });

  it("returns 503 when the worker has not completed a tick for longer than the stall threshold", async ({ env }) => {
    // Threshold clears the longest legitimate stage (a 300s VLM call) before it
    // can mean anything, so this has to be well beyond that.
    const stale = Date.now() - (testConfig().pipeline.vlm.requestTimeoutMs + 120_000);
    const app = appWith(env, () => ({ running: true, lastTickAt: stale, inFlightSince: null }));
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.statusCode).toBe(503);
    expect(res.json().worker.ok).toBe(false);
  });

  it("stays healthy while a tick is legitimately mid-flight in a long VLM call", async ({ env }) => {
    // A cold big-model load measured at 2m38s in the reference cluster. Flagging
    // that as unhealthy would restart the pod mid-escalation, which is worse
    // than the bug: the document would be re-claimed and pay the cold load again.
    const busySince = Date.now() - 150_000;
    const app = appWith(env, () => ({ running: true, lastTickAt: Date.now(), inFlightSince: busySince }));
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().worker.busyForMs).toBeGreaterThan(100_000);
  });

  it("does not degrade when only docling is unreachable", async ({ env }) => {
    // docling is a dependency that recovers on its own and whose failures the
    // pipeline retries. Restarting InvEx would not help.
    const app = appWith(env, () => alive);
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.json().docling).toBe(false);
    expect(res.statusCode).toBe(200);
  });

  it("omits the worker block when no probe is wired", async ({ env }) => {
    const app = buildApp({ db: env.db, config: testConfig() });
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().worker).toBeNull();
  });
});
