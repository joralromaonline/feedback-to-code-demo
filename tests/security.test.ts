import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSecurityError, WorkspaceTools } from "../packages/agent/src/tools.ts";

test("worker tools block path traversal and arbitrary scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "feedback-tools-test-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(join(root, "src", "file.js"), "export const value = 1;\n");
  const tools = new WorkspaceTools(root);
  assert.throws(() => tools.readFile("../outside.txt"), WorkspaceSecurityError);
  assert.equal(tools.runAllowedCommand("test") instanceof Promise, true);
});

test("bounded patch changes only the requested workspace file", () => {
  const root = mkdtempSync(join(tmpdir(), "feedback-tools-patch-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "src", "style.css"), ".button {\n  max-width: 120px;\n}\n");
  const tools = new WorkspaceTools(root);
  const result = tools.applyPatch("*** Begin Patch\n*** Update File: src/style.css\n@@\n-.button {\n-  max-width: 120px;\n-}\n+.button {\n+  max-width: none;\n+}\n*** End Patch");
  assert.deepEqual(result.changedFiles, ["src/style.css"]);
  assert.match(tools.readFile("src/style.css").content, /max-width: none/);
});
