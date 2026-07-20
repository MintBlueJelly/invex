import { PGlite } from "@electric-sql/pglite";
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

/**
 * In-process test environment: PGlite (real Postgres compiled to WASM) instead
 * of a container, so the FULL pipeline — worker loop, SKIP LOCKED claims,
 * migrations, event trace — verifies on machines without Docker.
 */

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => pg.close() };
}

export function testConfig(overrides?: (cfg: AppConfig) => void): AppConfig {
  const cfg = loadConfig({});
  cfg.pipeline.worker.pollIntervalMs = 10;
  overrides?.(cfg);
  return cfg;
}

export const silentLog = pino({ level: "silent" });

export const unusedDocling: DoclingPort = {
  convert() {
    return Promise.reject(new Error("docling not expected in this test"));
  },
};

/** Queue-based Docling fake: each convert() consumes the next enqueued response. */
export class FakeDocling implements DoclingPort {
  private queue: { doclingJson: unknown; markdown: string }[] = [];

  enqueue(doclingJson: unknown, markdown = ""): void {
    this.queue.push({ doclingJson, markdown });
  }

  convert(): Promise<{ doclingJson: unknown; markdown: string }> {
    const next = this.queue.shift();
    if (!next) return Promise.reject(new Error("FakeDocling queue is empty"));
    return Promise.resolve(next);
  }
}

export const unusedVlm: VlmPort = {
  extractStructured() {
    return Promise.reject(new Error("vlm not expected in this test"));
  },
};

export interface TestEnv {
  db: Db;
  config: AppConfig;
  ports: StagePorts;
  machine: Machine;
  app: ReturnType<typeof buildApp>;
  close: () => Promise<void>;
}

export async function createTestEnv(opts?: {
  config?: (cfg: AppConfig) => void;
  docling?: DoclingPort;
  vlm?: VlmPort;
  registry?: (r: ReturnType<typeof buildRegistry>) => void;
}): Promise<TestEnv> {
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
  const app = buildApp({ db, config });
  return {
    db,
    config,
    ports,
    machine,
    app,
    close: async () => {
      await app.close();
      await close();
    },
  };
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
