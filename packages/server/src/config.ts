import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * All tunables live in config/*.json at the repo root (override dir via
 * INVEX_CONFIG_DIR); secrets/endpoints come from the environment.
 */

const zPipelineConfig = z.object({
  triage: z.object({
    pagesToScan: z.number().int().positive(),
    textCharThreshold: z.number().int().nonnegative(),
  }),
  textGate: z.object({
    minDictHitRate: z.number().min(0).max(1),
    maxReplacementCharRatio: z.number().min(0).max(1),
    maxSingleCharTokenRatio: z.number().min(0).max(1),
    minTokensForVerdict: z.number().int().nonnegative(),
  }),
  reconcile: z.object({
    vatRates: z.array(z.number()),
    toleranceHeader: z.string(),
    toleranceLine: z.string(),
    lineSumSlackPerLine: z.string(),
    maxRepairPasses: z.number().int().positive(),
  }),
  defaults: z.object({
    currency: z.string().length(3),
  }),
  templates: z.object({
    induceFromRuleEngine: z.boolean(),
    minFieldConfidence: z.number().min(0).max(1),
  }),
  vlm: z.object({
    enabled: z.boolean(),
    rasterDpi: z.number().int().positive(),
    maxPages: z.number().int().positive(),
    requestTimeoutMs: z.number().int().positive(),
  }),
  worker: z.object({
    pollIntervalMs: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
  }),
});

const zClassifierConfig = z.object({
  weights: z.record(z.string(), z.number()),
  bands: z.object({
    invoiceMin: z.number(),
    nonInvoiceMax: z.number(),
  }),
});

export type PipelineConfig = z.infer<typeof zPipelineConfig>;
export type ClassifierConfig = z.infer<typeof zClassifierConfig>;

export interface AppConfig {
  pipeline: PipelineConfig;
  classifier: ClassifierConfig;
  databaseUrl: string;
  doclingUrl: string;
  vlmUrl: string;
  vlmModel: string;
  vlmApiKey: string;
  vlmSchemaMode: "response_format" | "ollama_format";
  port: number;
  logLevel: string;
  configDir: string;
  promptsDir: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configDir = env["INVEX_CONFIG_DIR"] ?? join(repoRoot, "config");
  const pipeline = zPipelineConfig.parse(
    JSON.parse(readFileSync(join(configDir, "pipeline.json"), "utf8")),
  );
  // Env override so deployments can enable the VLM without shipping a config
  // dir. Empty counts as unset (compose interpolates unset vars to "").
  const vlmEnabled = env["VLM_ENABLED"];
  if (vlmEnabled) pipeline.vlm.enabled = vlmEnabled === "true";
  const classifier = zClassifierConfig.parse(
    JSON.parse(readFileSync(join(configDir, "classifier.json"), "utf8")),
  );
  const schemaMode = env["VLM_SCHEMA_MODE"] === "ollama_format" ? "ollama_format" : "response_format";
  return {
    pipeline,
    classifier,
    databaseUrl: env["DATABASE_URL"] ?? "postgres://invex:invex@localhost:5432/invex",
    doclingUrl: env["DOCLING_URL"] ?? "http://localhost:5001",
    vlmUrl: env["VLM_URL"] ?? "http://localhost:11434",
    vlmModel: env["VLM_MODEL"] ?? "",
    vlmApiKey: env["VLM_API_KEY"] ?? "",
    vlmSchemaMode: schemaMode,
    port: Number(env["PORT"] ?? 8080),
    logLevel: env["LOG_LEVEL"] ?? "info",
    configDir,
    promptsDir: join(configDir, "prompts"),
  };
}
