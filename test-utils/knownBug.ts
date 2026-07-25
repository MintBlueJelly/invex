import { it as vitestIt } from "vitest";

// Declared locally rather than relying on @types/node: packages/core/tsconfig.json
// sets "types": [], so the global is not available in every program that imports this.
declare const process: { env: Record<string, string | undefined> };

/**
 * Pins behaviour that is currently WRONG.
 *
 * Backed by `it.fails()`, deliberately, rather than a skipped or filtered lane.
 * The decisive property is what happens when the defect is FIXED: a skipped test
 * tells nobody, rots, and lets the fix ship without its regression test. This one
 * runs on every CI invocation and goes RED with "Expected test to fail, but it
 * passed" the moment the bug is repaired — forcing promotion to a plain `it` in
 * the same commit. A tripwire in both directions.
 *
 * `it.fails()` passes for ANY failure, including one the test never intended, so:
 *   1. one narrow assertion per pin, and no setup that can throw;
 *   2. always pair a pin with a green `[current]` test recording what the code
 *      actually does today, so a refactor to a THIRD wrong behaviour is caught
 *      even though the pin still "passes";
 *   3. every id must appear in docs/known-bugs.md — enforced by
 *      packages/server/test/unit/knownBugs.registry.test.ts.
 *
 * INVEX_KNOWN_BUGS=strict flips these to ordinary tests, so `pnpm test:known-bugs`
 * reports what is still broken. That run is EXPECTED to be red; it is the backlog.
 */
export function knownBug(
  id: string,
  summary: string,
): { it: (name: string, fn: () => void | Promise<void>) => void } {
  if (!/^INVEX-\d{3}$/.test(id)) {
    throw new Error(`knownBug id must look like INVEX-001, got ${JSON.stringify(id)}`);
  }
  const strict = process.env["INVEX_KNOWN_BUGS"] === "strict";
  const run = strict ? vitestIt : vitestIt.fails;
  return {
    it: (name, fn) => run(`${name}  ⟨known-bug ${id}: ${summary}⟩`, fn),
  };
}
