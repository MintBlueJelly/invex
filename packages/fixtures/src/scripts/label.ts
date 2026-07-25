import { basename, join, resolve } from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SCENARIOS_DIR } from "../goldens";

/**
 * Turn a REAL invoice into a golden scenario.
 *
 *   pnpm fixtures:label ./fixtures-drop/acme-2026-001.pdf [--base http://localhost:8080]
 *
 * Ingests the PDF against a running stack, waits for a terminal status, and
 * writes `scenarios/real-NNNN.golden.json` containing the pipeline's OWN output
 * as a DRAFT canonical invoice, marked `reviewed: false`.
 *
 * The draft is a starting point for a human, never an expectation. Used as one
 * it would assert that the pipeline agrees with itself — the precise
 * circularity the golden corpus exists to remove — so goldenPurity.test.ts
 * fails the build if an unreviewed golden carries an expectation.
 *
 * The intended loop:
 *   1. drop real PDFs into fixtures-drop/
 *   2. pnpm smoke -- ./fixtures-drop            what did the pipeline do?
 *      escalated? GET /api/escalations says which constraint or rule failed
 *   3. pnpm fixtures:label <pdf>                draft a scenario from it
 *   4. CORRECT the draft by hand, set reviewed: true
 *   5. commit — it is now a permanent regression test, and the arithmetic
 *      guards in goldenConsistency.test.ts enforce that your corrections are
 *      internally sound
 *
 * This is also what briefing §11 needs: label enough real documents this way
 * and the classifier band calibration finally has its sample.
 */

const TERMINAL = new Set(["committed", "exported_markdown", "pending_review", "failed", "segmented"]);

interface Args {
  pdf: string;
  base: string;
  timeoutS: number;
  id: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { pdf: "", base: "http://localhost:8080", timeoutS: 300, id: "" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--base") args.base = argv[++i] ?? args.base;
    else if (a === "--timeout") args.timeoutS = Number(argv[++i] ?? args.timeoutS);
    else if (a === "--id") args.id = argv[++i] ?? "";
    else rest.push(a);
  }
  args.pdf = rest[0] ?? "";
  return args;
}

async function nextRealId(): Promise<string> {
  const used = (await readdir(SCENARIOS_DIR))
    .map((f) => /^real-(\d{4})\.golden\.json$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return `real-${String(Math.max(0, ...used) + 1).padStart(4, "0")}`;
}

export async function runLabel(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.pdf) {
    console.error("usage: pnpm fixtures:label <pdf> [--base URL] [--timeout SECONDS] [--id NAME]");
    return 2;
  }
  if (!Number.isFinite(args.timeoutS) || args.timeoutS <= 0) {
    console.error(`--timeout must be a positive number of seconds, got ${JSON.stringify(args.timeoutS)}`);
    return 2;
  }

  const bytes = await readFile(resolve(args.pdf));
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), basename(args.pdf));

  const ingest = await fetch(`${args.base}/api/ingest`, { method: "POST", body: form });
  if (!ingest.ok) {
    console.error(`ingest failed: ${ingest.status} ${await ingest.text()}`);
    return 1;
  }
  const [entry] = (await ingest.json()) as { documentId: string; deduplicated: boolean }[];
  if (!entry) {
    console.error("ingest accepted no file parts");
    return 1;
  }
  if (entry.deduplicated) {
    console.error(
      `note: this PDF was already ingested (${entry.documentId}); labelling its EXISTING result, ` +
        `which may predate the code you are testing`,
    );
  }

  // A VLM escalation can run for minutes; poll patiently.
  const deadline = Date.now() + args.timeoutS * 1000;
  let doc: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${args.base}/api/documents/${entry.documentId}`);
    if (res.ok) {
      doc = (await res.json()) as Record<string, unknown>;
      if (TERMINAL.has(String(doc["status"]))) break;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  if (!doc) {
    console.error("could not read the document back");
    return 1;
  }

  const status = String(doc["status"]);
  if (!TERMINAL.has(status)) {
    console.error(`document is still ${status} after ${args.timeoutS}s — not terminal, refusing to draft`);
    return 1;
  }

  const id = args.id || (await nextRealId());
  const result = (doc["result"] ?? null) as Record<string, unknown> | null;

  const golden = {
    id,
    title: `REVIEW ME — drafted from ${basename(args.pdf)}`,
    reviewed: false,
    authoredOn: new Date().toISOString().slice(0, 10),
    source: {
      /** Real PDFs are not reproduced from a LiteralInvoiceDoc; keep the file. */
      pdfFile: basename(args.pdf),
      documentId: entry.documentId,
      pipelineStatus: status,
      note:
        "DRAFT. expected.canonical below is the PIPELINE'S OWN OUTPUT, not verified truth. " +
        "Read the PDF, correct every field, then set reviewed: true. Until then " +
        "goldenPurity.test.ts requires expected.canonical to be null.",
    },
    // Held aside so an unreviewed draft carries no expectation, which is what
    // goldenPurity.test.ts enforces. Move this to expected.canonical once you
    // have checked it against the PDF.
    draftCanonical: result,
    expected: {
      canonical: null,
      smoke: {
        route: doc["route"] ?? undefined,
        terminalStatus: status,
      },
    },
  };

  const out = join(SCENARIOS_DIR, `${id}.golden.json`);
  await writeFile(out, `${JSON.stringify(golden, null, 2)}\n`, "utf8");

  console.log(`wrote ${out}`);
  console.log(`  status: ${status}   route: ${String(doc["route"])}`);
  console.log(`  NEXT: read ${basename(args.pdf)}, correct draftCanonical, move it to`);
  console.log(`        expected.canonical, and set reviewed: true.`);
  if (status === "pending_review") {
    console.log(`  This document did NOT reconcile — GET /api/escalations?documentId=${entry.documentId}`);
    console.log(`  says which constraint or rule failed. That is the thing worth fixing.`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await runLabel(process.argv.slice(2)));
}
