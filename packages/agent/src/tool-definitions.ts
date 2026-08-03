import type { AgentToolDefinition } from "../../openai/src/index.ts";
import { WorkspaceTools, type AllowedCommandId } from "./tools.ts";

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string").slice(0, 100);
}

export function createAgentToolDefinitions(tools: WorkspaceTools): AgentToolDefinition[] {
  return [
    {
      name: "list_files",
      description: "List repository files inside the isolated workspace. Returns paths only and never follows paths outside the workspace.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: () => tools.listFiles()
    },
    {
      name: "search_code",
      description: "Search literal text in repository files. Use semantic IDs, route names, component names, and exact UI text as queries.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { query: { type: "string", minLength: 1, maxLength: 500 }, paths: { type: "array", maxItems: 100, items: { type: "string", maxLength: 500 } } },
        required: ["query"]
      },
      execute: (args) => tools.searchCode(String(args.query || ""), optionalStringArray(args.paths))
    },
    {
      name: "read_file",
      description: "Read a bounded text range from one repository file.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { path: { type: "string", minLength: 1, maxLength: 500 }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } },
        required: ["path"]
      },
      execute: (args) => tools.readFile(String(args.path || ""), typeof args.startLine === "number" ? args.startLine : undefined, typeof args.endLine === "number" ? args.endLine : undefined)
    },
    {
      name: "apply_patch",
      description: "Apply one bounded replacement patch. Format: *** Begin Patch, *** Update File: relative/path, @@, removed lines prefixed -, replacement lines prefixed +, *** End Patch. Paths cannot leave the workspace.",
      parameters: { type: "object", additionalProperties: false, properties: { patch: { type: "string", minLength: 1, maxLength: 100_000 } }, required: ["patch"] },
      execute: (args) => tools.applyPatch(String(args.patch || ""))
    },
    {
      name: "run_allowed_command",
      description: "Run one validation script by its allowlisted ID. The model cannot provide a command string or arguments.",
      parameters: { type: "object", additionalProperties: false, properties: { commandId: { type: "string", enum: ["lint", "typecheck", "test", "build", "playwright"] } }, required: ["commandId"] },
      execute: async (args) => tools.runAllowedCommand(String(args.commandId) as AllowedCommandId)
    },
    {
      name: "git_diff",
      description: "Return the current diff and changed files for review. The output is limited to the isolated workspace snapshot.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: () => tools.gitDiff()
    }
  ];
}
