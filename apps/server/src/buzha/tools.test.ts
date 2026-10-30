import { join } from "node:path";
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
  it("refuses a tool outside the contract's tool_scope before any bridge call or delegation", async () => {
    let delegated = 0; const calls: string[] = [];
    const tools = new BuzhaTools({ bridge: async name => { calls.push(name); return session; }, delegate: async () => { delegated++; return { taskId: "child" }; } });
    const scoped = { ...task, spec: { ...task.spec, checks: [{ type: "tool_scope", allowed: ["browser_sessions", "workspace_write"] }] } } as AgentTask;
    await expect(tools.invoke(scoped, "delegate", { goal: "browser work" })).rejects.toThrow(/tool_scope/);
    await expect(tools.invoke(scoped, "browser_click", { tab_id: "12", selector: "#save" })).rejects.toThrow(/tool_scope/);
    expect(delegated).toBe(0); expect(calls).toHaveLength(0);
    await tools.invoke(scoped, "browser_sessions", {}); expect(calls).toEqual(["browser_sessions"]);
  });
  it.each(["browser_upload","browser_prepare_action"])("rejects incomplete %s upload arguments before calling the bridge or reserving an effect",async name=>{
    const f=fixture();
    for(const args of [{},{root:"y_apps"},{path:"Бужа/assets/avatar.png"}])await expect(f.tools.invoke(task,name,{action:"upload",tab_id:"12",selector:"#file",...args})).rejects.toThrow(/root.*path/);
    expect(f.calls).toHaveLength(0);expect(f.effects).toHaveLength(0);
  });
  it("passes complete upload preparation to the central policy without reserving or uploading",async()=>{
    const f=fixture();const args={action:"upload",tab_id:"12",selector:"#file",root:"y_apps",path:"Бужа/assets/avatar.png"};
    await f.tools.invoke(task,"browser_prepare_action",args);expect(f.calls.at(-1)).toEqual({name:"browser_prepare_action",args:{...args,session_id:"default"}});expect(f.effects).toHaveLength(0);
  });
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
  it("keeps one marked observer tab per site across restarts instead of opening new tabs", async () => {
    const { mkdtemp } = await import("node:fs/promises"); const { tmpdir } = await import("node:os");
    const observerFile = join(await mkdtemp(join(tmpdir(), "buzha-observer-")), "tabs.json");
    const created: string[] = [], navigated: string[] = [];
    const bridge = async (name: string, args: Record<string, unknown>) => {
      if (name === "browser_sessions") return session;
      if (name === "browser_tab_action") { created.push(String(args.url)); return { action: "create", tab_id: "88" }; }
      if (name === "browser_navigate") { navigated.push(String(args.url)); return { action: "navigation_started" }; }
      return { url: "https://www.fl.ru/users/buzhastudio/setup/main/", text: "ok", elements: [] };
    };
    const check = (url: string) => ({ type: "tool" as const, tool: "browser_observe_url", arguments: { url }, text: "ok" });
    expect((await new BuzhaTools({ bridge, observerFile }).check(task, check("https://www.fl.ru/users/buzhastudio/portfolio/"))).ok).toBe(false);
    await new BuzhaTools({ bridge, observerFile }).check(task, check("https://www.fl.ru/users/buzhastudio/setup/main/"));
    expect(created).toEqual(["https://www.fl.ru/users/buzhastudio/portfolio/?snarkroute_observer=1"]);
    expect(navigated).toEqual(["https://www.fl.ru/users/buzhastudio/setup/main/"]);
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
  it("reads one existing Sent message through a unique visible message link, never a send button",async()=>{
    let opened=false,finds=0;const clicks:string[]=[];
    const tool=new BuzhaTools({bridge:async(name,args)=>{
      if(name==="browser_sessions")return session;if(name==="browser_tab_action")return{action:"create",tab_id:"88"};
      if(name==="browser_snapshot")return{url:"https://mail.google.com/mail/u/0/#sent"+(opened?"/ABCDEFGHIJKLMNOP":""),readyState:"complete",text:opened?"Subject: Existing reply. Full body. From studio@example.test To client@example.test":"Sent: Existing reply",elements:[]};
      if(name==="browser_find")return{matches:args.query==="Existing reply"&&++finds>1?[{selector:"#message",label:"Existing reply",role:"link",tag:"div"}]:[]};
      if(name==="browser_click"){clicks.push(String(args.selector));opened=true;return{action:"clicked",status:"dispatched"};}throw Error(name);
    }});
    const result=await tool.invoke(task,"browser_observe_url",{url:"https://mail.google.com/mail/u/0/#sent",openSentSubject:"Existing reply"});
    expect(result.url).toContain("#sent/ABCDEFGHIJKLMNOP");expect(result.text).toContain("Full body");expect(clicks).toEqual(["#message"]);
    await expect(tool.invoke(task,"browser_observe_url",{url:"https://www.fl.ru/",openSentSubject:"Save"})).rejects.toThrow(/Отправленных/);
  });
});
