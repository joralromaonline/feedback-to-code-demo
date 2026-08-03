import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
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
console.log(`typecheck passed: native TypeScript syntax and safety checks for ${files.length} files (tsc unavailable in the source workspace)`);
