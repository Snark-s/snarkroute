import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  admissionForLocalRuntime,
  isLocalRuntimeId,
  readLocalRuntimeSnapshot,
  startLocalRuntime,
  stopLocalRuntime,
  type LocalRuntimeId
} from "../services/local-runtime-supervisor";

const runtimeId = z.string().min(1).max(128);

export function registerLocalRuntimeTools(server: McpServer): void {
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("local_runtime_status", {
    description: "Read current local GPU/runtime state before starting local inference. Includes built-in and automatically discovered loopback runtimes plus GPU/RAM pressure.",
    inputSchema: {},
    annotations: readOnly
  }, async () => output({ ok: true, snapshot: await readLocalRuntimeSnapshot() }));

  server.registerTool("local_runtime_admission", {
    description: "Check whether any registered local workload or daemon start is safe. Use intent=workload before GPU inference and surface warnings or unknown resource requirements to the user.",
    inputSchema: { runtimeId, intent: z.enum(["workload", "start"]).optional() },
    annotations: readOnly
  }, async input => output({
    ok: true,
    ...await admissionForLocalRuntime(input.runtimeId as LocalRuntimeId, input.intent ?? "workload")
  }));

  server.registerTool("local_runtime_start", {
    description: "Start a known local runtime through SnarkRoute. Refuses hard conflicts and requires force=true only for explicit warning confirmation.",
    inputSchema: { runtimeId, force: z.boolean().optional() }
  }, async input => {
    try {
      return output({ ok: true, ...await startLocalRuntime(input.runtimeId as LocalRuntimeId, { force: input.force === true }) });
    } catch (error) {
      return { ...output({ ok: false, error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
  });

  server.registerTool("local_runtime_stop", {
    description: "Stop a known local runtime through its safe lifecycle handler.",
    inputSchema: { runtimeId }
  }, async input => {
    if (!isLocalRuntimeId(input.runtimeId)) return { ...output({ ok: false, error: "Unknown local runtime." }), isError: true };
    try {
      return output({ ok: true, ...await stopLocalRuntime(input.runtimeId) });
    } catch (error) {
      return { ...output({ ok: false, error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
  });
}

function output(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
