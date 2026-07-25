import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGoldens, SCENARIOS_DIR } from "../../src/goldens";

/**
 * The oracle must stay independent of the code it judges.
 *
 * `computeInvoice`/`sampleSpec` are the arithmetic that used to generate BOTH
 * the fixture PDFs and `out/expected.json`. Any test or render path that reaches
 * them again re-creates the original problem: a suite that validates the
 * pipeline against its own arithmetic and therefore cannot fail for the right
 * reason. This test makes that regression impossible to land quietly.
 */

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));

/** Paths where reaching for the old generator would defeat the oracle. */
const GUARDED = [
  "packages/core/test",
  "packages/server/test",
  "packages/fixtures/test",
  "packages/fixtures/src/layout",
  "packages/fixtures/src/literal",
  "packages/fixtures/src/render",
  "packages/fixtures/src/goldens.ts",
];

function tsFilesUnder(rel: string): string[] {
  const abs = join(REPO, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return abs.endsWith(".ts") ? [abs] : [];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

/**
 * Files still importing the legacy generator, pending migration to goldens.
 *
 * A RATCHET: this list may only shrink. A new file reaching for computeInvoice
 * fails the test below, so the debt cannot grow while nobody is looking. Delete
 * entries as each is retargeted at loadGolden(); when the list is empty, delete
 * the allowlist and the old generator with it.
 */
const LEGACY_GENERATOR_USERS = [
  "packages/fixtures/test/unit/ciiRoundtrip.test.ts",
  "packages/server/test/e2e/smoke.cli.test.ts",
  "packages/server/test/integration/image.pipeline.test.ts",
  "packages/server/test/integration/review.api.test.ts",
  "packages/server/test/integration/text.pipeline.test.ts",
  "packages/server/test/integration/vlm.pipeline.test.ts",
  "packages/server/test/integration/zugferd.pipeline.test.ts",
];

/** Matches a real import, not a mention in a comment. */
const IMPORTS_GENERATOR = /import\s+(?:type\s+)?\{[^}]*\b(?:computeInvoice|sampleSpec)\b[^}]*\}\s*from/;

describe("oracle independence", () => {
  it("no NEW file imports computeInvoice or sampleSpec", () => {
    const offenders: string[] = [];
    for (const rel of GUARDED) {
      for (const file of tsFilesUnder(rel)) {
        const path = file.slice(REPO.length);
        if (LEGACY_GENERATOR_USERS.includes(path)) continue;
        if (IMPORTS_GENERATOR.test(readFileSync(file, "utf8"))) offenders.push(path);
      }
    }
    expect(offenders, "these reach the generator the goldens exist to replace").toEqual([]);
  });

  it("the legacy allowlist only shrinks — every entry still uses it", () => {
    // Keeps the ratchet honest in the other direction: a stale entry would let a
    // future file quietly re-adopt the generator under cover of the allowlist.
    const stale = LEGACY_GENERATOR_USERS.filter(
      (p) => !IMPORTS_GENERATOR.test(readFileSync(join(REPO, p), "utf8")),
    );
    expect(stale, "migrated — remove these from LEGACY_GENERATOR_USERS").toEqual([]);
  });

  it("goldens.ts renders only from the layout seam", () => {
    const src = readFileSync(join(REPO, "packages/fixtures/src/goldens.ts"), "utf8");
    // Every rendering must go through layoutInvoice, so the PDF, the Docling
    // JSON and the OCR JSON cannot describe different geometry.
    expect(src).toContain("layoutInvoice");
    expect(src).not.toMatch(/\bmakeTextInvoicePdf\b|\bmakeScannedPdf\b/);
  });
});

describe("draft goldens", () => {
  it("every scenario declares whether a human has reviewed it", () => {
    for (const g of loadGoldens()) {
      expect(typeof g.reviewed, `${g.id} is missing a reviewed flag`).toBe("boolean");
    }
  });

  it("an unreviewed draft carries no expectation", () => {
    // `pnpm fixtures:label` writes a golden from the PIPELINE'S OWN output. Used
    // as an expectation before a human checks it, it would assert that the
    // pipeline agrees with itself — the exact circularity this phase removes.
    // A draft is a starting point for review, never a test oracle.
    for (const g of loadGoldens()) {
      if (g.reviewed) continue;
      expect(g.expected.canonical, `${g.id} is unreviewed but carries a canonical expectation`).toBeNull();
    }
  });

  it("scenario ids match their filenames", () => {
    for (const f of readdirSync(SCENARIOS_DIR).filter((n) => n.endsWith(".golden.json"))) {
      const g = JSON.parse(readFileSync(join(SCENARIOS_DIR, f), "utf8")) as { id: string };
      expect(`${g.id}.golden.json`).toBe(f);
    }
  });
});
