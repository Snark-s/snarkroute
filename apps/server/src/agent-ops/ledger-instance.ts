import { join } from "node:path";
import { QuotaLedger } from "./quota-ledger";
import { AgentOpsStore } from "./store";

/**
 * The one quota ledger of this server process. The subscription chat services
 * and delegated coding runs both report into it, so a limit hit by one path is
 * respected by the other and several agents cannot spend a plan independently.
 */

export function agentOpsDataDirectory(): string {
  return process.env.AGENT_OPS_DATA_DIR?.trim() || join(process.cwd(), "data", "agent-ops");
}

let shared: { ledger: QuotaLedger; ready: Promise<void> } | undefined;

export function sharedQuotaLedger(): QuotaLedger {
  if (!shared) {
    const store = new AgentOpsStore(agentOpsDataDirectory());
    // Unit tests of the chat services must never write into the real data folder.
    const ephemeral = Boolean(process.env.VITEST) && !process.env.AGENT_OPS_DATA_DIR;
    const ledger = new QuotaLedger({ persist: ephemeral ? undefined : state => store.writeState("quota-ledger", state) });
    shared = { ledger, ready: ephemeral ? Promise.resolve() : store.readState("quota-ledger", {}).then(state => ledger.restore(state as Parameters<QuotaLedger["restore"]>[0])) };
  }
  return shared.ledger;
}

export async function sharedQuotaLedgerReady(): Promise<QuotaLedger> {
  const ledger = sharedQuotaLedger();
  await shared!.ready;
  return ledger;
}

/** Executor ids of the subscription transports, as the ledger names them. */
export const SUBSCRIPTION_EXECUTOR = { claude_subscription: "claude_code", chatgpt_subscription: "codex_cli" } as const;
