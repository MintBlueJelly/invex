import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Meta-test: docs/known-bugs.md and the suite cannot drift apart.
 *
 * Lives in the server package rather than core because core's tsconfig sets
 * "types": [] and this test needs node's fs.
 */

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const doc = join(repoRoot, "docs", "known-bugs.md");

const ID = /^INVEX-\d{3}$/;

async function testFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const pkg of ["core", "server", "fixtures"]) {
    const root = join(repoRoot, "packages", pkg, "test");
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".ts")) out.push(join(e.parentPath, e.name));
    }
  }
  return out;
}

/** Ids referenced by a `knownBug("INVEX-nnn", …)` call anywhere in the suite. */
async function idsUsedByTests(): Promise<Map<string, string[]>> {
  const used = new Map<string, string[]>();
  for (const file of await testFiles()) {
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(/knownBug\(\s*"(INVEX-\d{3})"/g)) {
      const id = m[1]!;
      used.set(id, [...(used.get(id) ?? []), file.slice(repoRoot.length)]);
    }
  }
  return used;
}

/** Ids in the markdown table, with their declared status. */
async function idsInDoc(): Promise<Map<string, string>> {
  const md = await readFile(doc, "utf8");
  const rows = new Map<string, string>();
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const id = cells[1] ?? "";
    if (!ID.test(id)) continue; // header and separator rows
    rows.set(id, cells[3] ?? "");
  }
  return rows;
}

describe("known-bug registry", () => {
  it("every id used by a test is documented in docs/known-bugs.md", async () => {
    const documented = await idsInDoc();
    const undocumented = [...(await idsUsedByTests())]
      .filter(([id]) => !documented.has(id))
      .map(([id, files]) => `${id} (used in ${files.join(", ")})`);
    expect(undocumented).toEqual([]);
  });

  it("every open id in docs/known-bugs.md is pinned by at least one test", async () => {
    const used = await idsUsedByTests();
    const unpinned = [...(await idsInDoc())]
      .filter(([, status]) => status === "open")
      .filter(([id]) => !used.has(id))
      .map(([id]) => id);
    expect(unpinned).toEqual([]);
  });

  it("no fixed id still has a knownBug() pin — those must be promoted to plain `it`", async () => {
    const used = await idsUsedByTests();
    const stale = [...(await idsInDoc())]
      .filter(([, status]) => status === "fixed")
      .filter(([id]) => used.has(id))
      .map(([id]) => `${id} (still pinned in ${used.get(id)!.join(", ")})`);
    expect(stale).toEqual([]);
  });

  it("documented statuses are one of open|fixed", async () => {
    const bad = [...(await idsInDoc())]
      .filter(([, status]) => status !== "open" && status !== "fixed")
      .map(([id, status]) => `${id}: ${JSON.stringify(status)}`);
    expect(bad).toEqual([]);
  });
});
