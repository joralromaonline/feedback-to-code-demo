import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/*.test.ts", "tests/unit/**/*.test.ts"],
    exclude: ["tests/fixtures/**", "tests/e2e/**"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
