import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agentOpsInstance } from "../agent-ops";
import { currentOpsContext } from "../agent-ops/context";
import { getRegisteredLocalRuntime } from "../services/local-runtime-registry";
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
    description: "Read current local GPU/runtime state before starting local inference. Includes built-in and automatically discovered loopback runtimes plus GPU/RAM pressure. Runtime buzha is the persistent app:buzha agent (shared queue, Acceptor, scoped SnarkBridge tools; use buzha_message/status/task/control); ready means her service is up. Workshop map and binding owner decisions: docs/WORKSHOP-PASSPORT.md.",
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
      const refusal = await agentRuntimeRefusal(input.runtimeId, "start");
      if (refusal) return { ...output({ ok: false, error: refusal }), isError: true };
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
    const refusal = await agentRuntimeRefusal(input.runtimeId, "stop");
    if (refusal) return { ...output({ ok: false, error: refusal }), isError: true };
    try {
      return output({ ok: true, ...await stopLocalRuntime(input.runtimeId) });
    } catch (error) {
      return { ...output({ ok: false, error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
  });
}

/**
 * Agents may not start a model that claims GPU memory while the owner needs the
 * computer, and may not stop a runtime another task or agent is using.
 */
async function agentRuntimeRefusal(runtimeId: string, action: "start" | "stop"): Promise<string | undefined> {
  const ops = await agentOpsInstance()?.catch(() => undefined);
  if (!ops) return undefined;
  const context = currentOpsContext();
  if (context.origin !== "agent") return undefined;
  if (action === "start") {
    const runtime = getRegisteredLocalRuntime(runtimeId);
    const mode = await ops.mode();
    if (runtime?.claimsOnStart && !mode.limits.heavy) return `Режим «${mode.label}»: агенты не запускают модели, занимающие GPU (${mode.reason}).`;
    return undefined;
  }
  const users = ops.dispatcher.list().filter(lease => lease.runtimeId === runtimeId && lease.agentId !== context.agentId);
  if (users.length) return `${runtimeId} используют: ${users.map(lease => `${lease.purpose} (${lease.agentId})`).join(", ")}. Остановка без согласования запрещена.`;
  return undefined;
}

function output(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
