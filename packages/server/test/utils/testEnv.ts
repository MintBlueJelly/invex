import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { pino } from "pino";
import { loadConfig, type AppConfig } from "../../src/config";
import { migrationsFolder, type Db } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { buildApp } from "../../src/http/app";
import { createMachine, type Machine, type StagePorts } from "../../src/pipeline/machine";
import { buildRegistry } from "../../src/pipeline/registry";
import type { DoclingPort, VlmPort } from "../../src/ports";
import { unusedDocling, unusedVlm } from "./doubles";

/**
 * In-process test environment: PGlite (real Postgres compiled to WASM) instead
 * of a container, so the FULL pipeline — worker loop, claims, migrations, event
 * trace — verifies on machines without Docker.
 *
 * Caveat worth knowing: PGlite is a SINGLE connection, so two "concurrent"
 * transactions serialize. FOR UPDATE SKIP LOCKED and every lost-update race are
 * therefore structurally untestable here — those live in the opt-in `pg` lane.
 */

export { FakeDocling, RecordingVlm, unusedDocling, unusedVlm } from "./doubles";

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => pg.close() };
}

/** Every table, in FK-safe order. Used by truncateAll(). */
const ALL_TABLES = [
  "document_events",
  "document_files",
  "escalations",
  "vendor_template_ibans",
  "vendor_templates",
  "documents",
] as const;

/**
 * Wipe all rows without rebuilding PGlite. A fresh PGlite + migrate() costs
 * ~300-500ms; for a component file with 20 tests that is 10s of pure setup.
 */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${ALL_TABLES.join(", ")} RESTART IDENTITY CASCADE`));
}

/** Deep-merge just enough for nested config objects (no arrays in AppConfig). */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== "object" || typeof base !== "object" || base === null) return patch as T;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge(out[k], v);
  }
  return out as T;
}

type ConfigOverride =
  /** Mutator form. */
  | ((cfg: AppConfig) => void)
  /** Declarative form: testConfig({ pipeline: { vlm: { enabled: true } } }). */
  | DeepPartial<AppConfig>;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function testConfig(overrides?: ConfigOverride): AppConfig {
  const cfg = loadConfig({});
  cfg.pipeline.worker.pollIntervalMs = 10;
  if (typeof overrides === "function") overrides(cfg);
  else if (overrides) return deepMerge(cfg, overrides);
  return cfg;
}

export const silentLog = pino({ level: "silent" });

export interface TestEnv {
  db: Db;
  config: AppConfig;
  ports: StagePorts;
  machine: Machine;
  app: ReturnType<typeof buildApp>;
  close: () => Promise<void>;
}

export interface TestEnvOptions {
  config?: ConfigOverride;
  docling?: DoclingPort;
  vlm?: VlmPort;
  registry?: (r: ReturnType<typeof buildRegistry>) => void;
}

export async function createTestEnv(opts?: TestEnvOptions): Promise<TestEnv> {
  const { db, close } = await createTestDb();
  const config = testConfig(opts?.config);
  const ports: StagePorts = {
    db,
    config,
    log: silentLog,
    docling: opts?.docling ?? unusedDocling,
    vlm: opts?.vlm ?? unusedVlm,
  };
  const registry = buildRegistry();
  opts?.registry?.(registry);
  const machine = createMachine(ports, registry);
  const app = buildApp({ db, config, worker: () => machine.health() });
  return {
    db,
    config,
    ports,
    machine,
    app,
    close: async () => {
      await machine.stop();
      await app.close();
      await close();
    },
  };
}

/** Same environment, but actually listening — for the e2e lane and the CLI harness. */
export async function createListeningTestEnv(
  opts?: TestEnvOptions,
): Promise<TestEnv & { baseUrl: string }> {
  const env = await createTestEnv(opts);
  await env.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = env.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { ...env, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Insert a document directly in a chosen state. Half the component tests want a
 * document at a given status, not a PDF pushed through four stages to get there.
 */
export async function seedDocument(
  db: Db,
  row: Partial<typeof schema.documents.$inferInsert> = {},
): Promise<string> {
  const [inserted] = await db
    .insert(schema.documents)
    .values({
      filename: "seed.pdf",
      contentHash: `seed-${Math.random().toString(36).slice(2)}`,
      status: "received",
      ...row,
    })
    .returning({ id: schema.documents.id });
  return inserted!.id;
}

/** Minimal multipart/form-data body for fastify.inject. */
export function multipartBody(files: { filename: string; data: Uint8Array }[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----invex-test-boundary-7f3a";
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${f.filename}"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.from(f.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
