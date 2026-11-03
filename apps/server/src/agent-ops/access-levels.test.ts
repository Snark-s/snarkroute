import { describe, expect, it } from "vitest";
import { AgentRegistry, agentBrief } from "./agents";

/** B1 guard for D-02: who gets which access level. */
describe("D-02 access levels", () => {
  const registry = new AgentRegistry([], { secret: Buffer.alloc(32, 1) });

  it("gives the owner 4, every authenticated agent and delegated executor 3, an anonymous caller 0", () => {
    expect(registry.owner().policy.level).toBe(4);
    for (const id of ["app:buzha", "app:secretary", "app:tove", "app:jabberwock", "mcp:codex", "mcp:claude-code"]) expect(registry.policyForAgent(id).level).toBe(3);
    expect(registry.policyForAgent("task:t-1:child").level).toBe(3);
    expect(registry.anonymous().policy.level).toBe(0);
  });

  it("fills the level of policies saved before D-02 and keeps an explicit one", () => {
    const restored = new AgentRegistry([], { secret: Buffer.alloc(32, 1) });
    const old = { ...restored.policy("agent") } as Record<string, unknown>; delete old.level;
    restored.restore({ policies: { policies: { agent: old as never, limited: { ...restored.policy("agent"), id: "limited", level: 1 } } } });
    expect(restored.policy("agent").level).toBe(3);
    expect(restored.policy("limited").level).toBe(1);
  });

  it("tells the agent its level in the brief", () => {
    expect(agentBrief(registry.mcpClient("brief-test"))).toContain("Access level 3 of 4");
  });
});
