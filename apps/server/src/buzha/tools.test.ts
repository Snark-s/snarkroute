import { describe, expect, it } from "vitest";
import { BuzhaTools, BUZHA_TOOLS } from "./tools";
import type { AgentTask } from "../agent-ops/types";
const task = { id: "night", agentId: "app:buzha", spec: { actor: "buzha", tools: BUZHA_TOOLS }, attempts: [{ n: 1 }] } as AgentTask;
const session = { sessions: [{ id: "default", profile_directory: "Profile 13", available: true }] };
function fixture(reply: unknown = { action: "clicked", status: "dispatched" }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [], effects: string[] = [];
  const tools = new BuzhaTools({ bridge: async (name, args) => { calls.push({ name, args }); if (name === "browser_sessions") return session; return reply; },
    effect: async (_task, key) => { const seen = effects.includes(key); if (!seen) effects.push(key); return { execute: !seen, state: seen ? "confirmed" : "started", result: seen ? reply : undefined }; } });
  return { tools, calls, effects };
}
describe("Buzha tools use the central bridge authority", () => {
  it("connects routine writes without fabricating approvals, always to Profile 13", async () => {
    const f = fixture({ action: "fill", filled: true }); const result = await f.tools.invoke(task, "browser_fill", { tab_id: "12", selector: "input[name=name]", value: "Бужа", session_id: "another" });
    expect(result.action).toBe("fill"); expect(result.effectKey).toMatch(/^tool:/);
    expect(f.calls[1]).toMatchObject({ name: "browser_fill", args: { session_id: "default", value: "Бужа" } });
    expect(f.calls[1].args).not.toHaveProperty("approval_id");
  });
  it("does not replay an already recorded identical action", async () => {
    const f = fixture(); const args = { tab_id: "12", selector: "button[type=submit]" };
    await f.tools.invoke(task, "browser_click", args); const duplicate = await f.tools.invoke(task, "browser_click", args);
    expect(duplicate.alreadyExecuted).toBe(true); expect(f.calls.filter(c => c.name === "browser_click")).toHaveLength(1);
  });
  it.each([{}, null, { accepted: true }, { action: "click", status: "outcome_unknown" }])("does not call an empty or uncertain reply completed: %j", async reply => {
    const f = fixture(reply); await expect(f.tools.invoke(task, "browser_click", { tab_id: "12", selector: "button" })).rejects.toThrow(/результат|исход|подтвержд/);
  });
  it("propagates central protected-action refusal and never falls back to another transport", async () => {
    let actions = 0;
    const f = new BuzhaTools({ bridge: async name => { if (name === "browser_sessions") return session; actions++; throw new Error("Protected form or unaccepted legal consent requires the owner directly"); }, effect: async () => ({ execute: true, state: "started" }) });
    await expect(f.invoke(task, "browser_click", { tab_id: "12", selector: "button" })).rejects.toThrow(/Protected form/);
    expect(actions).toBe(1);
  });
  it("waits through transient loading reads, without replaying a browser mutation", async () => {
    let reads=0,creates=0;
    const tool=new BuzhaTools({bridge:async name=>{if(name==="browser_sessions") return session;if(name==="browser_tab_action"){creates++;return {action:"create",tab_id:"99"};}if(name==="browser_snapshot"){reads++;if(reads<3) throw new Error("Browser command operation_refused_or_unknown; inspect the page before another attempt");return {url:"https://www.fl.ru/users/buzhastudio/portfolio/",readyState:"complete",text:"Бужа Студия",elements:[]};}throw new Error("unexpected command");}});
    const result=await tool.invoke(task,"browser_observe_url",{url:"https://www.fl.ru/users/buzhastudio/portfolio/"}); expect(result.independentReload).toBe(true);expect(reads).toBe(3);expect(creates).toBe(1);
  });
  it("independently reloads an observer tab without navigating another worker's tab", async () => {
    const commands: string[] = [];
    const tool = new BuzhaTools({ bridge: async (name, args) => {
      commands.push(name); if (name === "browser_sessions") return session;
      if (name === "browser_tab_action") return { action: "create", tab_id: "77" };
      if (name === "browser_snapshot") return { url: args.tab_id === "77" ? "https://www.fl.ru/users/buzhastudio/portfolio/" : "wrong", text: "Бужа Студия", elements: [] };
      return { action: "navigation_started" };
    } });
    const check = { type: "tool" as const, tool: "browser_observe_url", arguments: { url: "https://www.fl.ru/users/buzhastudio/portfolio/" }, text: "Бужа Студия" };
    expect((await tool.check(task, check)).ok).toBe(true); expect((await tool.check(task, check)).ok).toBe(true);
    expect(commands.filter(name => name === "browser_tab_action")).toHaveLength(1); expect(commands.filter(name => name === "browser_navigate")).toHaveLength(1);
    expect((await tool.check(task, { type: "tool", tool: "bridge_status" })).ok).toBe(false);
  });
  it("does not claim a Gmail message was independently loaded when the extension stripped its route",async()=>{
    const tool=new BuzhaTools({bridge:async name=>name==="browser_sessions"?session:name==="browser_tab_action"?{action:"create",tab_id:"88"}:{url:"https://mail.google.com/mail/u/0/",readyState:"complete",text:"Inbox"}});
    await expect(tool.invoke(task,"browser_observe_url",{url:"https://mail.google.com/mail/u/0/#sent/ABCDEFGHIJKLMNOP"})).rejects.toThrow(/фрагмент/);
  });
});
