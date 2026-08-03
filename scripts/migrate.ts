import { getConfig } from "../packages/config/src/index.ts";
import { createDatabasePool, runMigrations } from "../packages/db/src/client.ts";

const config = getConfig();
const pool = createDatabasePool(config.DATABASE_URL);
try {
  const applied = await runMigrations(pool);
  console.log(JSON.stringify({ migrated: true, applied }));
} finally {
  await pool.end();
}
