import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as schema from "./schema";

/**
 * Driver-agnostic database handle: production uses postgres.js, tests use
 * PGlite (in-process Postgres — full pipeline verification without Docker).
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
);

export async function runMigrations(db: ReturnType<typeof createDb>["db"]): Promise<void> {
  await migrate(db, { migrationsFolder });
}
