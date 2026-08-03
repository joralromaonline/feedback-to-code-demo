import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".next", "coverage"].includes(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|mjs)$/.test(entry.name)) files.push(full);
  }
}
walk(root);
const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", "--check", file], { stdio: "pipe" });
  } catch (error) {
    failures.push(`${relative(root, file)}: syntax check failed`);
  }
  const source = readFileSync(file, "utf8");
  if (/from ["']node:child_process["']/.test(source) && /(?<!\.)\b(exec|execSync|execFile)\s*\(/.test(source)) failures.push(`${relative(root, file)}: arbitrary shell execution is forbidden`);
  if (/shell:\s*true/.test(source)) failures.push(`${relative(root, file)}: arbitrary shell execution is forbidden`);
  if (/(?:OPENAI_API_KEY|NVIDIA_API_KEY)\s*=\s*["'][^"']+["']/.test(source) || /GITHUB_PRIVATE_KEY\s*=\s*["'][^"']+["']/.test(source)) failures.push(`${relative(root, file)}: hard-coded secret detected`);
}
const toolsSource = readFileSync(join(root, "packages/agent/src/tools.ts"), "utf8");
if (!toolsSource.includes("shell: false")) failures.push("packages/agent/src/tools.ts: command runner must use shell: false");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`lint passed: ${files.length} source files checked`);
