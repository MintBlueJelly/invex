import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTextInvoicePdf, makeZugferdPdf, sampleSpec, computeInvoice } from "@invex/fixtures";
import { runBatchIngest } from "../../src/scripts/batchIngest";
import { createTestEnv, FakeDocling, type TestEnv } from "../utils/testEnv";
import { invoiceDoclingJson } from "../utils/doclingFixtures";

/**
 * The Layer-4 harness end-to-end: a REAL listening HTTP server (PGlite-backed)
 * + the real worker loop; the CLI ingests a folder, polls to terminal status,
 * prints traces, and enforces an expected.json manifest.
 */

let env: TestEnv;
let docling: FakeDocling;
let base: string;
let dir: string;

beforeAll(async () => {
  docling = new FakeDocling();
  env = await createTestEnv({ docling });
  const address = await env.app.listen({ port: 0, host: "127.0.0.1" });
  base = address;
  env.machine.start();

  dir = await mkdtemp(join(tmpdir(), "invex-smoke-"));
  const spec = sampleSpec();
  const inv = computeInvoice(spec);
  await writeFile(join(dir, "a-zugferd.pdf"), await makeZugferdPdf(spec));
  await writeFile(join(dir, "b-text.pdf"), await makeTextInvoicePdf(sampleSpec({ invoiceNumber: "R-SMOKE-2" })));
  docling.enqueue(invoiceDoclingJson({ invoiceNumber: "R-SMOKE-2" }));
  await writeFile(
    join(dir, "expected.json"),
    JSON.stringify({
      "a-zugferd.pdf": {
        route: "zugferd",
        terminalStatus: "committed",
        gross: inv.totals.gross,
        lineCount: inv.lines.length,
        hasEvents: ["xml_parsed"],
      },
      "b-text.pdf": {
        route: "text",
        terminalStatus: "committed",
        hasEvents: ["classified", "reconciled"],
      },
    }),
  );
});

afterAll(async () => {
  await env.machine.stop();
  await env.close();
  await rm(dir, { recursive: true, force: true });
});

describe("pnpm smoke (batch harness)", () => {
  it("ingests a folder, traces paths, and passes the expectation manifest", async () => {
    const code = await runBatchIngest([dir, "--base", base, "--expect", join(dir, "expected.json"), "--timeout", "60"]);
    expect(code).toBe(0);
  });

  it("fails loudly when expectations are not met", async () => {
    await writeFile(
      join(dir, "expected.json"),
      JSON.stringify({ "a-zugferd.pdf": { terminalStatus: "pending_review" } }),
    );
    const code = await runBatchIngest([dir, "--base", base, "--expect", join(dir, "expected.json"), "--timeout", "60"]);
    expect(code).toBe(1);
  });
});
