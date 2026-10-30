import assert from "node:assert/strict";
import { BuzhaTools, BUZHA_TOOLS, buzhaObserverFile } from "../src/buzha/tools";
import type { AgentTask } from "../src/agent-ops/types";
const tools = new BuzhaTools({ observerFile: buzhaObserverFile() });
const task = { agentId: "app:buzha", spec: { actor: "buzha", tools: BUZHA_TOOLS } } as AgentTask;
try {
  const bridge = await tools.invoke(task, "bridge_status", {}), sessions = await tools.invoke(task, "browser_sessions", {});
  assert.equal(bridge.status, "ok"); const session = sessions.sessions.find((s: any) => s.id === "default"); assert.equal(session.profile_directory, "Profile 13"); assert.equal(session.available, true);
  console.log(JSON.stringify({ bridge: { status: bridge.status, version: bridge.version }, browser: { sessionId: session.id, profile: session.profile_directory, available: session.available }, writes: 0 }, null, 2));
} finally { await tools.close(); }
