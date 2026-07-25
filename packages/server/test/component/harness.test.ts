import { documents } from "../../src/db/schema";
import { crashingStage, flakyStage, slowStage } from "../utils/doubles";
import { describe, expect, it, makeItShared } from "../utils/fixture";
import { seedDocument, testConfig, truncateAll } from "../utils/testEnv";

/**
 * Self-test for the Phase 0 harness. Scaffolding that nothing exercises is
 * scaffolding nobody can trust — in particular the two properties the old
 * harness lacked: per-test isolation, and doubles that complain when a test
 * enqueues work the pipeline never consumed.
 */

describe("per-test isolation (it)", () => {
  it("test A sees an empty database and writes one document", async ({ env }) => {
    expect(await env.db.select().from(documents)).toHaveLength(0);
    await seedDocument(env.db, { filename: "a.pdf" });
    expect(await env.db.select().from(documents)).toHaveLength(1);
  });

  it("test B does NOT see test A's document", async ({ env }) => {
    // The old harness shared one PGlite per file, so this was 1 and tests had to
    // run in order. Ordering dependencies are now impossible.
    expect(await env.db.select().from(documents)).toHaveLength(0);
  });

  it("an unconsumed docling response fails the test at teardown", async ({ env }) => {
    const { FakeDocling } = await import("../utils/doubles");
    const d = new FakeDocling();
    d.enqueue({ some: "response" });
    expect(() => d.assertDrained()).toThrow(/unconsumed response/);
    expect(env.db).toBeDefined();
  });
});

const itShared = makeItShared();

describe("shared env + auto truncate (makeItShared)", () => {
  itShared("writes a document", async ({ env }) => {
    await seedDocument(env.db, { filename: "shared-a.pdf" });
    expect(await env.db.select().from(documents)).toHaveLength(1);
  });

  itShared("starts clean again despite reusing the same PGlite", async ({ env }) => {
    expect(await env.db.select().from(documents)).toHaveLength(0);
  });
});

describe("truncateAll", () => {
  it("clears every table, including children", async ({ env }) => {
    const id = await seedDocument(env.db, { filename: "t.pdf" });
    await seedDocument(env.db, { filename: "child.pdf", parentId: id });
    expect(await env.db.select().from(documents)).toHaveLength(2);

    await truncateAll(env.db);
    expect(await env.db.select().from(documents)).toHaveLength(0);
  });
});

describe("testConfig", () => {
  it("accepts the mutator form", () => {
    const cfg = testConfig((c) => {
      c.pipeline.vlm.enabled = true;
    });
    expect(cfg.pipeline.vlm.enabled).toBe(true);
    expect(cfg.pipeline.worker.pollIntervalMs).toBe(10);
  });

  it("accepts the declarative form and deep-merges rather than replacing", () => {
    const cfg = testConfig({ pipeline: { vlm: { enabled: true } } });
    expect(cfg.pipeline.vlm.enabled).toBe(true);
    // Siblings of the patched key survive — a shallow merge would drop these.
    expect(cfg.pipeline.vlm.maxPages).toBe(5);
    expect(cfg.pipeline.worker.maxAttempts).toBe(3);
  });
});

describe("stage doubles", () => {
  it("flakyStage throws n times then delegates, counting every call", async () => {
    const inner = flakyStage(2);
    const call = () => inner(null as never, null as never, null as never);
    await expect(call()).rejects.toThrow(/failure #1/);
    await expect(call()).rejects.toThrow(/failure #2/);
    await expect(call()).resolves.toBeUndefined();
    expect(inner.calls).toBe(3);
  });

  it("crashingStage rethrows a non-Error value verbatim", async () => {
    const stage = crashingStage("boom");
    await expect(stage(null as never, null as never, null as never)).rejects.toBe("boom");
  });

  it("slowStage resolves only after its delay", async () => {
    const stage = slowStage(30);
    const started = Date.now();
    await stage(null as never, null as never, null as never);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
