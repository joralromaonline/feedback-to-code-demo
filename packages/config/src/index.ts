import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv({ path: process.env.ENV_FILE || ".env", quiet: true });

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

const integerFromEnv = (minimum: number, maximum: number) => z.coerce.number().int().min(minimum).max(maximum);
const optionalPositiveIntegerFromEnv = z.preprocess(
  (value) => value === "" || value === null ? undefined : value,
  z.coerce.number().int().positive().optional()
);

export const RuntimeConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: integerFromEnv(1, 65_535).default(3001),
  PUBLIC_API_ORIGIN: z.url().default("http://localhost:3001"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanFromEnv.default(true),
  S3_SERVER_SIDE_ENCRYPTION: z.enum(["none", "AES256"]).default("none"),
  INTERNAL_SERVICE_TOKEN: z.string().min(16),
  PUBLIC_DEMO_PROJECT_KEY: z.string().min(12),
  INTEGRATION_MODE: z.enum(["mock", "real"]).default("mock"),
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().optional().default("gpt-5.6"),
  OPENAI_TIMEOUT_MS: integerFromEnv(1_000, 600_000).default(120_000),
  OPENAI_MAX_AGENT_TURNS: integerFromEnv(1, 100).default(40),
  OPENAI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).default("medium"),
  GITHUB_APP_ID: z.string().optional().default(""),
  GITHUB_PRIVATE_KEY_BASE64: z.string().optional().default(""),
  GITHUB_WEBHOOK_SECRET: z.string().optional().default(""),
  GITHUB_INSTALLATION_ID: optionalPositiveIntegerFromEnv,
  GITHUB_OWNER: z.string().optional().default(""),
  GITHUB_REPO: z.string().optional().default(""),
  GITHUB_BASE_BRANCH: z.string().min(1).default("main"),
  GITHUB_API_VERSION: z.string().default("2026-03-10"),
  WORKER_MAX_CONCURRENCY: integerFromEnv(1, 16).default(1),
  WORKSPACE_ROOT: z.string().min(1).default("/tmp/feedback-workspaces"),
  COMMAND_TIMEOUT_MS: integerFromEnv(1_000, 600_000).default(120_000),
  ALLOW_NETWORK_INSTALL: booleanFromEnv.default(false),
  MOCK_TARGET_REPO: z.string().min(1).default("tests/fixtures/repo-basic"),
  AUTO_MIGRATE: booleanFromEnv.default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
}).superRefine((value, context) => {
  if (value.INTEGRATION_MODE !== "real") return;
  const required: Array<keyof typeof value> = ["OPENAI_API_KEY", "OPENAI_MODEL", "GITHUB_APP_ID", "GITHUB_PRIVATE_KEY_BASE64", "GITHUB_INSTALLATION_ID", "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_WEBHOOK_SECRET"];
  for (const key of required) {
    if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required when INTEGRATION_MODE=real` });
  }
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

let cachedConfig: RuntimeConfig | undefined;

export function getConfig(overrides: Record<string, unknown> = {}): RuntimeConfig {
  if (!Object.keys(overrides).length && cachedConfig) return cachedConfig;
  const parsed = RuntimeConfigSchema.parse({ ...process.env, ...overrides });
  if (!Object.keys(overrides).length) cachedConfig = parsed;
  return parsed;
}

export function githubPrivateKey(config: RuntimeConfig): string {
  if (!config.GITHUB_PRIVATE_KEY_BASE64) return "";
  return Buffer.from(config.GITHUB_PRIVATE_KEY_BASE64, "base64").toString("utf8");
}

export function clearConfigCache(): void {
  cachedConfig = undefined;
}
