import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    // Integration tests self-skip without Docker; generous timeout for Testcontainers pulls.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
