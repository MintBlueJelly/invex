import { defineConfig } from "vitest/config";

/**
 * Six lanes, split by what a test OWNS and the cheapest thing that can hold it.
 * `pnpm test:unit` is the inner loop and must stay fast — that is the point of
 * the split. Lanes that are still empty (`prop`, `pg`, server `unit`) are
 * declared so later phases slot in without reconfiguring; hence passWithNoTests.
 */
const shared = { environment: "node" as const, passWithNoTests: true };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "unit", // pure, no I/O
          include: [
            "packages/core/test/unit/**/*.test.ts",
            "packages/fixtures/test/unit/**/*.test.ts",
            "packages/server/test/unit/**/*.test.ts",
          ],
          testTimeout: 5_000,
          hookTimeout: 5_000,
          isolate: false, // pure code — no module state to protect between files
        },
      },
      {
        test: {
          ...shared,
          name: "prop", // fast-check invariants (Phase 5')
          include: ["packages/*/test/property/**/*.prop.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          ...shared,
          name: "component", // PGlite, no listening socket
          include: ["packages/server/test/component/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          pool: "forks",
        },
      },
      {
        test: {
          ...shared,
          name: "integration", // PGlite + app.inject + the real worker loop
          include: ["packages/server/test/integration/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          pool: "forks",
        },
      },
      {
        test: {
          ...shared,
          name: "e2e", // real listening server + the CLI harness
          include: ["packages/server/test/e2e/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          pool: "forks",
          fileParallelism: false,
        },
      },
      {
        test: {
          ...shared,
          name: "pg", // opt-in: needs a real Postgres; excluded from `pnpm test`
          include: ["packages/server/test/concurrency/**/*.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 300_000,
          pool: "forks",
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/fixtures/src/scripts/**",
        "packages/server/src/main.ts",
        "packages/server/src/index.ts",
        "packages/*/src/**/*.d.ts",
      ],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      // Ratcheted one phase at a time from the MEASURED value, rounded down for
      // noise. Never set aspirational numbers here — a permanently red gate
      // teaches everyone to ignore it. Raise at each phase boundary; never lower.
      //
      //   Phase 0  89.03 / 85.95 / 90.30 / 70.83   (lines/stmts/funcs/branches)
      //   Phase F  91.15 / 88.13 / 92.40 / 74.35
      //
      // Read these numbers carefully: high LINE coverage does not mean the code
      // is verified. The pre-existing integration tests executed most of the
      // pipeline while asserting on very little of it — which is exactly how
      // eleven defects survived at 89% line coverage. Branch coverage is the
      // more honest signal, and it is the one that moved most.
      thresholds: { lines: 91, statements: 88, functions: 92, branches: 74 },
    },
  },
});
