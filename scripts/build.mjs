import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.ts$/.test(entry.name)) files.push(full);
  }
}
walk(root);
for (const file of files) execFileSync(process.execPath, ["--experimental-strip-types", "--check", file], { stdio: "pipe" });
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "build-manifest.json"), JSON.stringify({ builtAt: new Date().toISOString(), sourceFilesChecked: files.length, runtime: "node-native-typescript-strip" }, null, 2));
console.log(`build passed: ${files.length} TypeScript source files checked; dist/build-manifest.json generated`);
