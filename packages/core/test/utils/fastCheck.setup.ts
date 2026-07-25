import fc from "fast-check";

/**
 * Property-run configuration.
 *
 * `numRuns` is deliberately modest by default and raised in the nightly job:
 * properties earn their keep by exploring the space over time, not by making
 * every local run slow. `FC_SEED` reproduces a specific counterexample —
 * fast-check prints the seed on failure, and every counterexample it finds
 * should be promoted to a named unit test with the literal input, so the
 * regression is pinned by an example rather than by luck of the draw.
 */
declare const process: { env: Record<string, string | undefined> };

fc.configureGlobal({
  numRuns: Number(process.env["FC_NUM_RUNS"] ?? 200),
  ...(process.env["FC_SEED"] ? { seed: Number(process.env["FC_SEED"]) } : {}),
});
