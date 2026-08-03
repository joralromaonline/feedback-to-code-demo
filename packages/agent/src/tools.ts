import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ValidationReport, ValidationResult } from "../../domain/src/index.ts";

export type AllowedCommandId = "lint" | "typecheck" | "test" | "build" | "playwright";

export interface CodeMatch { path: string; line: number; content: string; }

export class WorkspaceSecurityError extends Error {}

function walk(root: string, directory = root): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walk(root, full));
    else paths.push(relative(root, full));
  }
  return paths;
}

export class WorkspaceTools {
  readonly root: string;
  private readonly original = new Map<string, string>();

  constructor(root: string) {
    this.root = resolve(root);
    for (const path of walk(this.root)) {
      try { this.original.set(path, readFileSync(join(this.root, path), "utf8")); } catch { /* binary file */ }
    }
  }

  safePath(input: string): string {
    if (!input || input.includes("\0")) throw new WorkspaceSecurityError("Invalid workspace path");
    const candidate = resolve(this.root, input);
    const prefix = this.root.endsWith("/") ? this.root : `${this.root}/`;
    if (candidate !== this.root && !candidate.startsWith(prefix)) throw new WorkspaceSecurityError("Path escapes workspace");
    return candidate;
  }

  listFiles(): { paths: string[] } { return { paths: walk(this.root).sort() }; }

  searchCode(query: string, paths?: string[]): { matches: CodeMatch[] } {
    if (!query || query.length > 500) throw new WorkspaceSecurityError("Search query is invalid");
    const candidates = paths?.map((path) => this.safePath(path)) || walk(this.root).map((path) => this.safePath(path));
    const matches: CodeMatch[] = [];
    for (const absolute of candidates) {
      if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
      let content = "";
      try { content = readFileSync(absolute, "utf8"); } catch { continue; }
      content.split("\n").forEach((line, index) => {
        if (line.includes(query) && matches.length < 100) matches.push({ path: relative(this.root, absolute), line: index + 1, content: line.slice(0, 300) });
      });
    }
    return { matches };
  }

  readFile(path: string, startLine?: number, endLine?: number): { content: string } {
    const content = readFileSync(this.safePath(path), "utf8");
    const lines = content.split("\n");
    return { content: lines.slice(Math.max((startLine || 1) - 1, 0), endLine || lines.length).join("\n") };
  }

  applyPatch(patch: string): { changedFiles: string[]; diffStat: string } {
    const header = /^\*\*\* Begin Patch\n\*\*\* Update File: ([^\n]+)\n([\s\S]*?)\n\*\*\* End Patch$/m.exec(patch);
    if (!header) throw new WorkspaceSecurityError("Only the bounded update-file patch format is allowed");
    const path = header[1].trim();
    const absolute = this.safePath(path);
    const content = readFileSync(absolute, "utf8");
    const patchLines = header[2].split("\n");
    const oldLines = patchLines.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
    const newLines = patchLines.filter((line) => line.startsWith("+")).map((line) => line.slice(1));
    if (!oldLines.length || !newLines.length) throw new WorkspaceSecurityError("Patch must replace at least one line");
    const oldBlock = oldLines.join("\n");
    const newBlock = newLines.join("\n");
    if (!content.includes(oldBlock)) throw new WorkspaceSecurityError(`Patch context not found in ${path}`);
    writeFileSync(absolute, content.replace(oldBlock, newBlock), "utf8");
    return { changedFiles: [path], diffStat: `${path}: ${oldLines.length} line(s) replaced` };
  }

  gitDiff(): { diff: string; files: string[]; diffStat: string } {
    const files: string[] = [];
    const sections: string[] = [];
    for (const path of walk(this.root)) {
      let current: string;
      try { current = readFileSync(join(this.root, path), "utf8"); } catch { continue; }
      const before = this.original.get(path) ?? "";
      if (before === current) continue;
      files.push(path);
      sections.push(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@\n-${before.trimEnd()}\n+${current.trimEnd()}`);
    }
    return { diff: sections.join("\n"), files, diffStat: `${files.length} file(s) changed` };
  }

  detectValidationCommands(): AllowedCommandId[] {
    const packagePath = this.safePath("package.json");
    if (!existsSync(packagePath)) return [];
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
    const result: AllowedCommandId[] = [];
    for (const id of ["lint", "typecheck", "test", "build", "playwright"] as AllowedCommandId[]) {
      if (id === "playwright" && (packageJson.scripts?.playwright || packageJson.scripts?.["test:e2e"])) result.push(id);
      else if (packageJson.scripts?.[id]) result.push(id);
    }
    return result;
  }

  async runAllowedCommand(commandId: AllowedCommandId, timeoutMs = 20_000): Promise<ValidationResult> {
    const started = Date.now();
    const packagePath = this.safePath("package.json");
    if (!existsSync(packagePath)) return { commandId, status: "not_configured", durationMs: Date.now() - started, reason: "package.json not found" };
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
    const scriptName = commandId === "playwright" ? packageJson.scripts?.playwright ? "playwright" : packageJson.scripts?.["test:e2e"] ? "test:e2e" : undefined : packageJson.scripts?.[commandId] ? commandId : undefined;
    if (!scriptName) return { commandId, status: "not_configured", durationMs: Date.now() - started, reason: "Script is not configured" };
    let argv: string[];
    if (existsSync(this.safePath("pnpm-lock.yaml"))) argv = ["pnpm", "run", scriptName];
    else if (existsSync(this.safePath("yarn.lock"))) argv = ["yarn", "run", scriptName];
    else argv = ["npm", "run", scriptName, "--"];
    return new Promise((resolveResult) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: this.root, shell: false, env: { PATH: process.env.PATH || "" } });
      let output = "";
      let timedOut = false;
      const append = (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-20_000); };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolveResult({ commandId, status: "failed", durationMs: Date.now() - started, exitCode: 1, output, reason: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveResult({ commandId, status: timedOut ? "timed_out" : code === 0 ? "passed" : "failed", durationMs: Date.now() - started, exitCode: code ?? undefined, output });
      });
    });
  }

  writeReport(report: ValidationReport): { reportId: string } {
    writeFileSync(this.safePath("validation-report.json"), JSON.stringify(report, null, 2), "utf8");
    return { reportId: "validation-report.json" };
  }
}
