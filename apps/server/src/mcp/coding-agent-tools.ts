import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const execFileAsync = promisify(execFile);
const discoveryScript = fileURLToPath(new URL("../../../../scripts/discover-coding-agents.ps1", import.meta.url));

export const CODING_AGENT_DISCOVERY_INSTRUCTIONS =
  " For a complex coding task that exceeds your available tools, call coding_agents_discover before proposing a handoff. "+
  "Installed/authenticated CLI is not proof of remaining subscription quota. The current tool is discovery-only; it does not submit work. "+
  "Do not claim a Codex or Claude task was delegated unless a real job was launched and recorded.";

export function registerCodingAgentTools(server: McpServer): void {
  server.registerTool(
    "coding_agents_discover",
    {
      description: "Discover local Codex and Claude Code CLI availability without making a model call or exposing credentials. Reports quota=unknown until actual provider evidence exists. Read-only: no task submission.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        if (process.platform !== "win32" || !existsSync(discoveryScript)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ schema_version: 1, available: false, reason: "Windows discovery script unavailable", executors: [] }),
            }],
          };
        }
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", discoveryScript], {
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 24_000,
          encoding: "utf8",
        });
        const parsed = JSON.parse(stdout);
        if (!parsed || !Array.isArray(parsed.executors)) throw new Error("Invalid discovery result");
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ...parsed,
              delegation: { status: "not_yet_implemented", note: "Discovery does not launch agents or validate remaining provider quotas." },
            }),
          }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "unavailable",
              reason: error instanceof Error ? error.message : "Discovery failed",
            }),
          }],
        };
      }
    },
  );
}
