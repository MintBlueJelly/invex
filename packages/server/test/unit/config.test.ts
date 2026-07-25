import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, repoRoot } from "../../src/config";
import { knownBug } from "../../../../test-utils/knownBug";

/**
 * loadConfig(env) is how the reference deployment turns the VLM escalation
 * path on (docs/deployment.md: committed config/pipeline.json ships vlm.enabled:
 * false, the cluster sets VLM_ENABLED=true). These tests exercise every env
 * override with an explicit env object — never process.env.
 */

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A config dir seeded from the real committed JSON (so it always matches the
 * zod schema) with one field patched — used to make VLM_ENABLED overrides
 * observable from a non-default baseline.
 */
function altConfigDir(patchPipeline: (p: Record<string, any>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "invex-config-test-"));
  tempDirs.push(dir);
  const pipeline = JSON.parse(readFileSync(join(repoRoot, "config", "pipeline.json"), "utf8"));
  patchPipeline(pipeline);
  writeFileSync(join(dir, "pipeline.json"), JSON.stringify(pipeline));
  writeFileSync(join(dir, "classifier.json"), readFileSync(join(repoRoot, "config", "classifier.json"), "utf8"));
  return dir;
}

describe("loadConfig defaults (empty env)", () => {
  const cfg = loadConfig({});

  it("matches the committed pipeline.json — vlm.enabled is false, as docs/deployment.md assumes", () => {
    expect(cfg.pipeline.vlm.enabled).toBe(false);
  });

  it("parses config/pipeline.json with every documented top-level section present", () => {
    expect(Object.keys(cfg.pipeline).sort()).toEqual(
      ["defaults", "reconcile", "templates", "textGate", "triage", "vlm", "worker"].sort(),
    );
  });

  it("parses config/classifier.json with every documented top-level key present", () => {
    expect(Object.keys(cfg.classifier).sort()).toEqual(["bands", "weights"].sort());
  });

  it("falls back to localhost connection strings", () => {
    expect(cfg.databaseUrl).toBe("postgres://invex:invex@localhost:5432/invex");
    expect(cfg.doclingUrl).toBe("http://localhost:5001");
    expect(cfg.vlmUrl).toBe("http://localhost:11434");
  });

  it("defaults vlmModel and vlmApiKey to empty strings, not undefined", () => {
    expect(cfg.vlmModel).toBe("");
    expect(cfg.vlmApiKey).toBe("");
  });

  it("defaults vlmSchemaMode to response_format", () => {
    expect(cfg.vlmSchemaMode).toBe("response_format");
  });

  it("defaults port to 8080 and logLevel to info", () => {
    expect(cfg.port).toBe(8080);
    expect(cfg.logLevel).toBe("info");
  });

  it("defaults configDir to <repoRoot>/config and derives promptsDir from it", () => {
    expect(cfg.configDir).toBe(join(repoRoot, "config"));
    expect(cfg.promptsDir).toBe(join(cfg.configDir, "prompts"));
    expect(existsSync(join(cfg.configDir, "pipeline.json"))).toBe(true);
  });
});

describe("INVEX_CONFIG_DIR override", () => {
  // Documented nowhere outside this test — proves an alternate config dir is
  // actually honoured, not just parsed as a path string.
  it("reads pipeline.json/classifier.json from the overridden directory instead of repoRoot/config", () => {
    const dir = altConfigDir((p) => {
      p.triage.pagesToScan = 777;
    });
    const cfg = loadConfig({ INVEX_CONFIG_DIR: dir });
    expect(cfg.pipeline.triage.pagesToScan).toBe(777);
    expect(cfg.configDir).toBe(dir);
    expect(cfg.promptsDir).toBe(join(dir, "prompts"));
  });
});

describe("VLM_ENABLED override", () => {
  it('"true" enables the VLM even when the committed config ships it disabled', () => {
    expect(loadConfig({ VLM_ENABLED: "true" }).pipeline.vlm.enabled).toBe(true);
  });

  it('"false" disables the VLM even when the config dir ships it enabled', () => {
    const dir = altConfigDir((p) => {
      p.vlm.enabled = true;
    });
    expect(loadConfig({ INVEX_CONFIG_DIR: dir, VLM_ENABLED: "false" }).pipeline.vlm.enabled).toBe(false);
  });

  it('"" (unset by compose interpolation) leaves the config-dir value untouched', () => {
    const dir = altConfigDir((p) => {
      p.vlm.enabled = true;
    });
    expect(loadConfig({ INVEX_CONFIG_DIR: dir, VLM_ENABLED: "" }).pipeline.vlm.enabled).toBe(true);
  });

  const PLAUSIBLE_TRUTHY_SPELLINGS = ["1", "yes", "TRUE", "on"];

  it(
    "[current] a plausible truthy spelling (1, yes, TRUE, on) silently DISABLES the VLM " +
      "instead of enabling or rejecting it — only the literal string \"true\" enables",
    () => {
      for (const spelling of PLAUSIBLE_TRUTHY_SPELLINGS) {
        const dir = altConfigDir((p) => {
          p.vlm.enabled = true;
        });
        const cfg = loadConfig({ INVEX_CONFIG_DIR: dir, VLM_ENABLED: spelling });
        expect(cfg.pipeline.vlm.enabled, `VLM_ENABLED=${spelling}`).toBe(false);
      }
    },
  );

  knownBug("INVEX-053", "VLM_ENABLED is asymmetric: only the exact string \"true\" enables the VLM").it(
    "a plausible truthy spelling (1, yes, TRUE, on) should enable the VLM, not disable it",
    () => {
      for (const spelling of PLAUSIBLE_TRUTHY_SPELLINGS) {
        const dir = altConfigDir((p) => {
          p.vlm.enabled = false;
        });
        const cfg = loadConfig({ INVEX_CONFIG_DIR: dir, VLM_ENABLED: spelling });
        expect(cfg.pipeline.vlm.enabled, `VLM_ENABLED=${spelling}`).toBe(true);
      }
    },
  );
});

describe("VLM_SCHEMA_MODE override", () => {
  it('"ollama_format" is honoured', () => {
    expect(loadConfig({ VLM_SCHEMA_MODE: "ollama_format" }).vlmSchemaMode).toBe("ollama_format");
  });

  it('"response_format" is honoured explicitly too', () => {
    expect(loadConfig({ VLM_SCHEMA_MODE: "response_format" }).vlmSchemaMode).toBe("response_format");
  });

  // Not a known-bug id: recorded because the fallback direction (silently
  // "safe" response_format) matters operationally if someone typos the value
  // that would have switched an Ollama deployment's request shape.
  it('[current] an unrecognised value (e.g. a typo) silently falls back to "response_format", no error', () => {
    expect(loadConfig({ VLM_SCHEMA_MODE: "ollama-format" }).vlmSchemaMode).toBe("response_format");
    expect(loadConfig({ VLM_SCHEMA_MODE: "Ollama_Format" }).vlmSchemaMode).toBe("response_format");
    expect(loadConfig({ VLM_SCHEMA_MODE: "bogus" }).vlmSchemaMode).toBe("response_format");
  });
});

describe("simple string overrides", () => {
  it("VLM_MODEL, VLM_API_KEY, VLM_URL, DOCLING_URL, DATABASE_URL are all honoured verbatim", () => {
    const cfg = loadConfig({
      VLM_MODEL: "qwen2.5-vl:7b",
      VLM_API_KEY: "sk-test-key",
      VLM_URL: "http://vlm.internal:11434",
      DOCLING_URL: "http://docling.internal:5001",
      DATABASE_URL: "postgres://u:p@db.internal:5432/invex",
    });
    expect(cfg.vlmModel).toBe("qwen2.5-vl:7b");
    expect(cfg.vlmApiKey).toBe("sk-test-key");
    expect(cfg.vlmUrl).toBe("http://vlm.internal:11434");
    expect(cfg.doclingUrl).toBe("http://docling.internal:5001");
    expect(cfg.databaseUrl).toBe("postgres://u:p@db.internal:5432/invex");
  });
});

describe("PORT override", () => {
  it("a valid numeric string is parsed", () => {
    expect(loadConfig({ PORT: "3000" }).port).toBe(3000);
  });

  it("[current] a non-numeric value silently becomes NaN instead of raising an error", () => {
    const cfg = loadConfig({ PORT: "web" });
    expect(Number.isNaN(cfg.port)).toBe(true);
  });

  knownBug("INVEX-054", "PORT/LOG_LEVEL/*_URL are unvalidated; NaN port binds an arbitrary free port").it(
    "an invalid PORT should fail fast instead of producing NaN",
    () => {
      expect(() => loadConfig({ PORT: "web" })).toThrow();
    },
  );
});

describe("LOG_LEVEL override", () => {
  it("[current] any string is accepted verbatim, including one pino does not recognise", () => {
    expect(loadConfig({ LOG_LEVEL: "bogus-level" }).logLevel).toBe("bogus-level");
  });

  knownBug("INVEX-054", "LOG_LEVEL is unvalidated at config load time (pino only throws later, at import)").it(
    "an unrecognised LOG_LEVEL should be rejected when the config is loaded",
    () => {
      expect(() => loadConfig({ LOG_LEVEL: "bogus-level" })).toThrow();
    },
  );
});

describe("*_URL overrides are not validated as URLs", () => {
  it("[current] a garbage string passes straight through for DATABASE_URL/DOCLING_URL/VLM_URL", () => {
    const cfg = loadConfig({
      DATABASE_URL: "not a url",
      DOCLING_URL: "also not a url",
      VLM_URL: "definitely not a url",
    });
    expect(cfg.databaseUrl).toBe("not a url");
    expect(cfg.doclingUrl).toBe("also not a url");
    expect(cfg.vlmUrl).toBe("definitely not a url");
  });

  knownBug("INVEX-054", "DATABASE_URL/DOCLING_URL/VLM_URL are not URL-validated").it(
    "a malformed connection string should be rejected when the config is loaded",
    () => {
      expect(() => loadConfig({ DATABASE_URL: "not a url" })).toThrow();
      expect(() => loadConfig({ DOCLING_URL: "also not a url" })).toThrow();
      expect(() => loadConfig({ VLM_URL: "definitely not a url" })).toThrow();
    },
  );
});
