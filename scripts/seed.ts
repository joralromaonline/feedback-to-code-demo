import { getConfig } from "../packages/config/src/index.ts";
import { createDatabasePool, runMigrations } from "../packages/db/src/client.ts";
import { PostgresFeedbackStore } from "../packages/db/src/store.ts";

const config = getConfig();
const pool = createDatabasePool(config.DATABASE_URL);
try {
  await runMigrations(pool);
  const store = new PostgresFeedbackStore(pool);
  const project = await store.seedProject({
    id: "proj_demo", publicKey: config.PUBLIC_DEMO_PROJECT_KEY, name: "Feedback-to-Code demo",
    githubInstallationId: config.GITHUB_INSTALLATION_ID, githubOwner: config.GITHUB_OWNER || "demo", githubRepo: config.GITHUB_REPO || "checkout-demo", githubBaseBranch: config.GITHUB_BASE_BRANCH
  });
  console.log(JSON.stringify({ seeded: true, projectId: project.id }));
} finally {
  await pool.end();
}
