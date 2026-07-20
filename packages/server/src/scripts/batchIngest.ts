import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Batch smoke harness (plan: Layer 4). Ingests every PDF in a folder against a
 * RUNNING server, waits for terminal status, and prints one row per document
 * with the full pipeline path from the document event trace.
 *
 *   pnpm smoke -- ./fixtures-drop [--base http://localhost:8080] [--expect expected.json] [--timeout 120]
 */

interface Expectation {
  route?: string;
  terminalStatus?: string;
  gross?: string;
  lineCount?: number;
  hasEvents?: string[];
}

const TERMINAL = new Set(["committed", "exported_markdown", "pending_review", "failed", "segmented"]);

function parseArgs(argv: string[]) {
  const args = { folder: "", base: "http://localhost:8080", expect: "", timeoutS: 120 };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--base") args.base = argv[++i] ?? args.base;
    else if (a === "--expect") args.expect = argv[++i] ?? "";
    else if (a === "--timeout") args.timeoutS = Number(argv[++i] ?? args.timeoutS);
    else rest.push(a);
  }
  args.folder = rest[0] ?? "./fixtures-drop";
  return args;
}

interface TraceEvent {
  event: string;
  detail: Record<string, unknown> | null;
}

function hop(e: TraceEvent): string | null {
  const d = e.detail ?? {};
  switch (e.event) {
    case "ingested": return null;
    case "routed": return `routed:${d["route"]}`;
    case "xml_parsed": return "xml_parsed";
    case "xml_fallthrough": return "xml_fallthrough";
    case "text_gate": return `gate:${d["verdict"]}`;
    case "segmented": return `segmented(${d["segments"]})`;
    case "vendor_resolved":
      return d["templateId"] ? `vendor:${d["matchedBy"]}` : "vendor:miss";
    case "template_applied": return `template(${d["fieldsHit"]})`;
    case "rules_applied": return `rules(${d["found"]})`;
    case "classified": return `classified:${d["band"]}(${d["score"]})`;
    case "reconciled": {
      const repairs = Array.isArray(d["repairs"]) ? d["repairs"].length : 0;
      const violations = Array.isArray(d["violations"]) ? d["violations"].length : 0;
      return `reconciled:${d["status"]}(${repairs}r/${violations}v)`;
    }
    case "vlm_called": return `vlm:${d["model"] ?? "?"}`;
    case "template_induced": return "template_induced";
    case "escalated": return `escalated:${d["to"]}`;
    case "committed": return "committed";
    case "markdown_exported": return "markdown";
    case "review_committed": return "review_committed";
    case "stage_error": return "error!";
    case "failed": return "FAILED";
    default: return e.event;
  }
}

export async function runBatchIngest(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  // pnpm runs scripts in the package dir; INIT_CWD is where the user invoked.
  const base = process.env["INIT_CWD"] ?? process.cwd();
  const folder = resolve(base, args.folder);
  const files = (await readdir(folder)).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  if (files.length === 0) {
    console.error(`no PDFs found in ${folder}`);
    return 1;
  }
  const expectations: Record<string, Expectation> = args.expect
    ? (JSON.parse(await readFile(resolve(base, args.expect), "utf8")) as Record<string, Expectation>)
    : {};

  console.log(`ingesting ${files.length} PDFs from ${folder} → ${args.base}\n`);

  // Ingest
  const docs: { file: string; id: string }[] = [];
  for (const file of files) {
    const bytes = await readFile(join(folder, file));
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), file);
    const res = await fetch(`${args.base}/api/ingest`, { method: "POST", body: form });
    if (!res.ok) {
      console.error(`${file}: ingest failed ${res.status} ${await res.text()}`);
      return 1;
    }
    const body = (await res.json()) as { documentId: string }[];
    docs.push({ file, id: body[0]!.documentId });
  }

  // Poll to terminal
  const deadline = Date.now() + args.timeoutS * 1000;
  const status = new Map<string, Record<string, unknown>>();
  const pending = new Set(docs.map((d) => d.id));
  while (pending.size > 0 && Date.now() < deadline) {
    for (const id of [...pending]) {
      const res = await fetch(`${args.base}/api/documents/${id}`);
      const doc = (await res.json()) as Record<string, unknown>;
      status.set(id, doc);
      if (TERMINAL.has(String(doc["status"]))) pending.delete(id);
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, 750));
  }

  // Report
  const failures: string[] = [];
  for (const { file, id } of docs) {
    const doc = status.get(id) ?? {};
    const traceRes = await fetch(`${args.base}/api/documents/${id}/trace`);
    const trace = (await traceRes.json()) as { events: TraceEvent[] };
    const hops = trace.events.map(hop).filter((h): h is string => h !== null);
    const result = doc["result"] as { totals?: { gross?: string }; lineItems?: unknown[] } | null;
    const gross = result?.totals?.gross ?? "-";
    const lines = result?.lineItems?.length ?? "-";
    const st = String(doc["status"] ?? "?");
    const stMark = pending.has(id) ? `${st} (TIMEOUT)` : st;

    console.log(`${file}`);
    console.log(`  ${id}  ${stMark}  gross=${gross}  lines=${lines}`);
    console.log(`  path: ${hops.join(" → ")}`);

    const exp = expectations[file];
    if (exp) {
      const problems: string[] = [];
      if (exp.route && doc["route"] !== exp.route) problems.push(`route: expected ${exp.route}, got ${doc["route"]}`);
      if (exp.terminalStatus && st !== exp.terminalStatus) problems.push(`status: expected ${exp.terminalStatus}, got ${st}`);
      if (exp.gross && gross !== exp.gross) problems.push(`gross: expected ${exp.gross}, got ${gross}`);
      if (exp.lineCount !== undefined && lines !== exp.lineCount) problems.push(`lineCount: expected ${exp.lineCount}, got ${lines}`);
      for (const ev of exp.hasEvents ?? []) {
        if (!trace.events.some((e) => e.event === ev)) problems.push(`missing expected event ${ev}`);
      }
      if (problems.length > 0) {
        failures.push(`${file}:\n    ${problems.join("\n    ")}`);
        console.log(`  EXPECT-FAIL:\n    ${problems.join("\n    ")}`);
      } else {
        console.log("  expect: ok");
      }
    }
    console.log();
  }

  if (args.expect) {
    if (failures.length > 0) {
      console.error(`\n${failures.length} expectation failure(s)`);
      return 1;
    }
    console.log("all expectations met");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await runBatchIngest(process.argv.slice(2)));
}
