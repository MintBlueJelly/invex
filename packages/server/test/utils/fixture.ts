import { test as base } from "vitest";
import { FakeDocling, RecordingVlm } from "./doubles";
import { createTestEnv, truncateAll, type TestEnv, type TestEnvOptions } from "./testEnv";

/**
 * Extended `it` giving every test its own database and its own doubles.
 *
 * The suite this replaces used a module-scoped beforeAll sharing one PGlite
 * across every test in a file, and three files depended on test ORDERING — one
 * test inserted the template the next asserted on. That is a script, not a
 * suite: any .only, reorder or parallel run breaks it, and it hides bugs,
 * because "the template already existed" is indistinguishable from "the
 * template was created correctly".
 *
 * Two flavours:
 *   `it`       — a virgin database per test. Use in integration/.
 *   `makeItShared()` — one database per FILE plus TRUNCATE between tests, for
 *                component/ files where a ~400ms PGlite boot per test dominates.
 * Either way an ordering dependency becomes impossible.
 */

export interface Fixtures {
  docling: FakeDocling;
  vlm: RecordingVlm;
  env: TestEnv;
}

/** Per-test isolation: fresh PGlite, fresh doubles, drained on teardown. */
export const it = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- vitest requires the destructured first arg
  docling: async ({}, use) => {
    const d = new FakeDocling();
    await use(d);
    d.assertDrained();
  },
  // eslint-disable-next-line no-empty-pattern
  vlm: async ({}, use) => {
    const v = new RecordingVlm();
    await use(v);
    v.assertDrained();
  },
  env: async ({ docling, vlm }, use) => {
    const env = await createTestEnv({ docling, vlm });
    await use(env);
    await env.close();
  },
});

export interface SharedFixtures {
  docling: FakeDocling;
  vlm: RecordingVlm;
  env: TestEnv;
  /** Auto-applied: truncates every table before each test in the file. */
  cleanDb: void;
}

/**
 * One environment per file, TRUNCATEd between tests. `opts` is applied once, so
 * this is also how a file pins config (e.g. vlm.enabled) for all of its tests.
 *
 * The doubles are file-scoped here too — a file-scoped fixture may only depend
 * on file-scoped fixtures — so `assertDrained()` runs once at file teardown
 * rather than after each test. That is the trade for not paying a PGlite boot
 * per test; use the per-test `it` when you want the stricter check.
 */
export function makeItShared(opts?: TestEnvOptions) {
  return base.extend<SharedFixtures>({
    docling: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const d = new FakeDocling();
        await use(d);
        d.assertDrained();
      },
      { scope: "file" },
    ],
    vlm: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const v = new RecordingVlm();
        await use(v);
        v.assertDrained();
      },
      { scope: "file" },
    ],
    env: [
      async ({ docling, vlm }, use) => {
        const env = await createTestEnv({ docling, vlm, ...opts });
        await use(env);
        await env.close();
      },
      { scope: "file" },
    ],
    cleanDb: [
      async ({ env }, use) => {
        await truncateAll(env.db);
        await use();
      },
      { auto: true },
    ],
  });
}

export { truncateAll };
export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
