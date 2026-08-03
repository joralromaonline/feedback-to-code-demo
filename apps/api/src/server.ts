import { getConfig } from "../../../packages/config/src/index.ts";
import { buildProductionApi } from "../../../packages/api/src/production.ts";

const config = getConfig();
const app = await buildProductionApi(config);

await app.listen({ port: config.PORT, host: "0.0.0.0" });

const shutdown = async () => { await app.close(); process.exit(0); };
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
