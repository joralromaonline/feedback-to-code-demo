import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { RuntimeConfigSchema } from "../packages/config/src/index.ts";
import { detectScreenshotMime, parseScreenshot } from "../packages/contracts/src/index.ts";
import { signGitHubWebhook, verifyGitHubWebhook } from "../packages/github/src/webhook.ts";

const baseConfig = {
  DATABASE_URL: "postgres://feedback:feedback@localhost:5432/feedback",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "feedback-screenshots",
  S3_ACCESS_KEY: "local",
  S3_SECRET_KEY: "local-secret",
  INTERNAL_SERVICE_TOKEN: "internal-token-1234",
  PUBLIC_DEMO_PROJECT_KEY: "pk_demo_public_key"
};

describe("production contracts", () => {
  test("real mode requires OpenAI and GitHub server credentials", () => {
    const parsed = RuntimeConfigSchema.safeParse({ ...baseConfig, INTEGRATION_MODE: "real" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.path[0])).toContain("OPENAI_API_KEY");
  });

  test("real NVIDIA mode requires NVIDIA credentials instead of OpenAI credentials", () => {
    const missing = RuntimeConfigSchema.safeParse({ ...baseConfig, INTEGRATION_MODE: "real", LLM_PROVIDER: "nvidia" });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      const paths = missing.error.issues.map((issue) => issue.path[0]);
      expect(paths).toContain("NVIDIA_API_KEY");
      expect(paths).not.toContain("OPENAI_API_KEY");
    }

    const config = RuntimeConfigSchema.parse({
      ...baseConfig,
      INTEGRATION_MODE: "real",
      LLM_PROVIDER: "nvidia",
      NVIDIA_API_KEY: "nvapi-test-only",
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY_BASE64: "dGVzdA==",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      GITHUB_INSTALLATION_ID: "456",
      GITHUB_OWNER: "owner",
      GITHUB_REPO: "repo"
    });
    expect(config.NVIDIA_MODEL).toBe("deepseek-ai/deepseek-v4-pro");
    expect(config.NVIDIA_TIMEOUT_MS).toBe(60_000);
    expect(config.NVIDIA_CLASSIFICATION_TIMEOUT_MS).toBe(90_000);
    expect(config.NVIDIA_AGENT_TIMEOUT_MS).toBe(600_000);
    expect(config.NVIDIA_MAX_AGENT_TURNS).toBe(12);
    expect(config.NVIDIA_MAX_OUTPUT_TOKENS).toBe(4_096);
    expect(config.OPENAI_API_KEY).toBe("");
  });

  test("mock mode accepts infrastructure configuration without external secrets", () => {
    const config = RuntimeConfigSchema.parse({ ...baseConfig, INTEGRATION_MODE: "mock", GITHUB_INSTALLATION_ID: "" });
    expect(config.INTEGRATION_MODE).toBe("mock");
    expect(config.GITHUB_INSTALLATION_ID).toBeUndefined();
  });

  test("GitHub webhook signatures use HMAC SHA-256 and constant-time verification", () => {
    const secret = "It's a Secret to Everybody";
    const payload = "Hello, World!";
    const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    expect(signGitHubWebhook(secret, payload)).toBe(expected);
    expect(verifyGitHubWebhook(secret, payload, expected)).toBe(true);
    expect(verifyGitHubWebhook(secret, `${payload}!`, expected)).toBe(false);
  });

  test("screenshot validation rejects MIME spoofing", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(detectScreenshotMime(png)).toBe("image/png");
    expect(() => parseScreenshot({ bytes: png, declaredMime: "image/webp" })).toThrow(/MIME/);
  });
});
