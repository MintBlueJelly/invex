import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  goldenDocling,
  goldenPdf,
  loadGolden,
  serializeCiiFromCanonical,
} from "@invex/fixtures";
import { PDFDocument, AFRelationship } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBatchIngest } from "../../src/scripts/batchIngest";
import { createTestEnv, FakeDocling, type TestEnv } from "../utils/testEnv";

/**
 * The batch harness end-to-end: a REAL listening HTTP server (PGlite-backed)
 * plus the real worker loop. The CLI ingests a folder, polls to terminal status,
 * prints traces, and enforces an expected.json manifest.
 *
 * Inputs and expectations both come from one golden scenario, but from its two
 * INDEPENDENTLY authored halves: the PDF is rendered from the literal printed
 * page, the manifest from the hand-written canonical invoice. Previously both
 * sides came out of computeInvoice(), so the manifest could not disagree with
 * the fixture.
 */

const GOLDEN = loadGolden("de-standard-19");
const CANONICAL = GOLDEN.expected.canonical!;

/** ZUGfERD = the same page plus the CII attachment Path A reads. */
async function zugferdPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await goldenPdf(GOLDEN));
  doc.attach(new TextEncoder().encode(serializeCiiFromCanonical(CANONICAL)), "factur-x.xml", {
    mimeType: "application/xml",
    afRelationship: AFRelationship.Alternative,
  });
  return doc.save();
}

let env: TestEnv;
let docling: FakeDocling;
let base: string;
let dir: string;

beforeAll(async () => {
  docling = new FakeDocling();
  env = await createTestEnv({ docling });
  base = await env.app.listen({ port: 0, host: "127.0.0.1" });
  env.machine.start();

  dir = await mkdtemp(join(tmpdir(), "invex-smoke-"));
  await writeFile(join(dir, "a-zugferd.pdf"), await zugferdPdf());
  await writeFile(join(dir, "b-text.pdf"), await goldenPdf(GOLDEN));
  // Only the text lane calls docling; Path A reads the embedded XML.
  docling.enqueue(goldenDocling(GOLDEN), `# ${GOLDEN.render!.doc.headingText}`);

  await writeFile(
    join(dir, "expected.json"),
    JSON.stringify({
      "a-zugferd.pdf": {
        route: "zugferd",
        terminalStatus: "committed",
        gross: CANONICAL.totals.gross,
        lineCount: CANONICAL.lineItems.length,
        hasEvents: ["xml_parsed"],
        // Path A must not touch docling at all.
        notEvents: ["text_gate", "vlm_called"],
        canonical: CANONICAL,
      },
      "b-text.pdf": {
        route: "text",
        terminalStatus: "committed",
        hasEvents: ["classified", "reconciled"],
        notEvents: ["vlm_called"],
      },
    }),
  );
});

afterAll(async () => {
  await env.machine.stop();
  await env.close();
  await rm(dir, { recursive: true, force: true });
});

const run = (extra: string[] = []) =>
  runBatchIngest([dir, "--base", base, "--expect", join(dir, "expected.json"), "--timeout", "60", ...extra]);

describe("pnpm smoke (batch harness)", () => {
  it("ingests a folder, traces paths, and passes the expectation manifest", async () => {
    expect(await run()).toBe(0);
  });

  it("compares the full canonical invoice under --strict-canonical", async () => {
    // Without this flag the harness checks the gross total and the line COUNT
    // and nothing else, so a wrong description or unit price passes cleanly.
    expect(await run(["--strict-canonical"])).toBe(0);
  });

  it("fails loudly when a canonical field disagrees", async () => {
    const wrong = structuredClone(CANONICAL);
    wrong.lineItems[0]!.unitPrice = "999.99";
    await writeFile(
      join(dir, "expected.json"),
      JSON.stringify({ "a-zugferd.pdf": { canonical: wrong } }),
    );
    expect(await run(["--strict-canonical"])).toBe(1);
  });

  it("fails loudly when expectations are not met", async () => {
    await writeFile(
      join(dir, "expected.json"),
      JSON.stringify({ "a-zugferd.pdf": { terminalStatus: "pending_review" } }),
    );
    expect(await run()).toBe(1);
  });
});
