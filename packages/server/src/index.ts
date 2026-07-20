export { buildApp, type AppDeps } from "./http/app";
export { loadConfig, repoRoot, type AppConfig } from "./config";
export { createDb, runMigrations, type Db } from "./db/client";
export * as dbSchema from "./db/schema";
export { createMachine, type Machine, type StagePorts, type StageRegistry } from "./pipeline/machine";
export { buildRegistry } from "./pipeline/registry";
export type { DoclingPort, VlmPort } from "./ports";
export { triagePdf } from "./pdf/triage";
