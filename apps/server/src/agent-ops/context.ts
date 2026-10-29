import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who started the current call chain. MCP requests and delegated tasks run as
 * "agent"; a call with no context is the owner's interactive request from the
 * Workshop or BoojumRoute. `heldRuntimes` lets work inside a task reuse the
 * lease the scheduler already granted instead of competing with itself.
 */
export type OpsContext = { origin: "owner" | "agent"; agentId: string; taskId?: string; heldRuntimes?: string[] };

export const opsContext = new AsyncLocalStorage<OpsContext>();

export function currentOpsContext(): OpsContext {
  return opsContext.getStore() ?? { origin: "owner", agentId: "owner" };
}
