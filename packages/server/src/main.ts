import { join } from "node:path";
import { pino } from "pino";
import { loadConfig, repoRoot } from "./config";
import { createDb, runMigrations } from "./db/client";
import { buildApp } from "./http/app";
import { createMachine, type StagePorts } from "./pipeline/machine";
import { buildRegistry } from "./pipeline/registry";
import { createDoclingClient } from "./clients/docling";
import { createOpenAiCompatVlm } from "./clients/vlm/openaiCompat";
import type { VlmPort } from "./ports";

try {
  process.loadEnvFile(join(repoRoot, ".env"));
} catch {
  // no .env — environment variables or defaults apply
}

const config = loadConfig();
const log = pino({ level: config.logLevel });

const { db, sql } = createDb(config.databaseUrl);
await runMigrations(db);
log.info("migrations applied");

const vlmUnavailable: VlmPort = {
  extractStructured() {
    return Promise.reject(
      new Error("no VLM configured (set VLM_MODEL and pipeline.vlm.enabled)"),
    );
  },
};
const vlm: VlmPort =
  config.pipeline.vlm.enabled && config.vlmModel !== ""
    ? createOpenAiCompatVlm({
        baseUrl: config.vlmUrl,
        model: config.vlmModel,
        schemaMode: config.vlmSchemaMode,
        timeoutMs: config.pipeline.vlm.requestTimeoutMs,
        ...(config.vlmApiKey !== "" ? { apiKey: config.vlmApiKey } : {}),
      })
    : vlmUnavailable;

const ports: StagePorts = {
  db,
  config,
  log: log.child({ component: "pipeline" }),
  docling: createDoclingClient(config.doclingUrl, config.pipeline.vlm.requestTimeoutMs),
  vlm,
};

const app = buildApp({ db, config, log: log.child({ component: "http" }) });
const machine = createMachine(ports, buildRegistry());

await app.listen({ port: config.port, host: "0.0.0.0" });
machine.start();
log.info({ port: config.port }, "InvEx server up");

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  await machine.stop();
  await app.close();
  await sql.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
