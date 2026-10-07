import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JabberwockMemoryService } from "./service";
import { SnarkRouteAtomicAgentRuntime } from "./atomic-agent-runtime";
import type { AtomicToolCall } from "./atomic-tools";
import { SupervisorBridge, type SupervisorAgentRuntime } from "./supervisor-bridge";

const directories: string[] = [];
const memories: JabberwockMemoryService[] = [];
afterEach(async () => {
  for (const memory of memories.splice(0)) memory.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("atomic Supervisor agent runtime", () => {
  it("counts actual model calls when the progress detector stops a repeated inspection loop", async () => {
    const root = await workspace(); await writeFile(join(root, "example.ts"), "const one = 1;\n");
    const model = { execute: vi.fn(async () => ({ response: JSON.stringify({ content: "Inspect", tool_actions: [{ name: "fs.read", arguments: { path: "example.ts" } }] }) })) };
    const runtime = new SnarkRouteAtomicAgentRuntime(model);
    await expect(runtime.execute({ taskId: "task", stepId: "step", instruction: "Repair one", contextPacket: "Repair one",
      rootPath: root, routing: { mode: "fixed", model: "local" }, permissions: "read_write" })).rejects.toMatchObject({ metadata: { modelCalls: 4, toolCallCount: 4, stalledToolLoop: true } });
    expect(model.execute).toHaveBeenCalledTimes(4);
  });
  it("recognizes unchanged source across different queries and overlapping reads and prompts a local repair", async () => {
    const root = await workspace(); await writeFile(join(root, "example.ts"), "export const foo = 1;\nexport const bar = 2;\n");
    let calls = 0;
    const runtime = new SnarkRouteAtomicAgentRuntime({ execute: async input => {
      expect(input.generation).toEqual({ maxTokens: 2048, temperature: 0, jsonObject: true });
      calls++;
      const actions: AtomicToolCall[] = calls === 1 ? [{ name: "fs.read", arguments: { path: "example.ts" } }]
        : calls === 2 ? [{ name: "fs.search", arguments: { path: "example.ts", query: "foo" } }]
        : calls === 3 ? [{ name: "fs.read", arguments: { path: "example.ts", startLine: 1, endLine: 1 } }]
        : [];
      if (calls === 4) {
        expect(input.contextPacket).toContain("Progress stalled");
        actions.push({ name: "fs.patch", arguments: { path: "example.ts", old: "foo = 1", new: "foo = 3" } });
      }
      return { response: JSON.stringify({ content: calls >= 5 ? "Fixed current instruction" : "Inspect/repair", tool_actions: actions }) };
    } });
    await runtime.execute({ taskId: "task", stepId: "step", instruction: "Fix foo", contextPacket: "Make foo equal 3",
      rootPath: root, routing: { mode: "fixed", model: "bonsai" }, permissions: "read_write" });
    expect(await readFile(join(root, "example.ts"), "utf8")).toContain("foo = 3"); expect(calls).toBe(5);
  });
  it("finalizes read-only verification after bounded inspection instead of repeating tools indefinitely", async () => {
    const root = await workspace(); await writeFile(join(root, "example.ts"), "const one = 1;\nconst two = 2;\nconst three = 3;\n");
    let calls = 0;
    const runtime = new SnarkRouteAtomicAgentRuntime({ execute: async input => {
      calls++;
      if (calls <= 3) return { response: JSON.stringify({ content: "Inspect", tool_actions: [
        { name: "fs.read", arguments: { path: "example.ts", startLine: calls === 1 ? 1 : calls, endLine: 3 } }
      ] }) };
      expect(input.contextPacket).toContain("FINAL VERIFICATION TURN");
      expect(input.contextPacket).toContain("Allowed tools: []");
      return { response: JSON.stringify({ content: { verdict: "retry", summary: "One local change remains", evidence: ["Read all three actual lines"], safeToRetry: true }, tool_actions: [] }) };
    } });
    const result = await runtime.execute({ taskId: "task", stepId: "step", instruction: "Verify all three lines", contextPacket: "Inspect actual state",
      rootPath: root, routing: { mode: "fixed", model: "bonsai" }, permissions: "read_only", phase: "verification" });
    expect(JSON.parse(result.response).verdict).toBe("retry"); expect(calls).toBe(4);
    expect(result.metadata).toMatchObject({ toolCallCount: 3 });
  });
  it("allows additional necessary files during verification while inspections provide new evidence", async () => {
    const root = await workspace();
    for (let index = 1; index <= 5; index++) await writeFile(join(root, `file${index}.ts`), `export const value${index} = ${index};\n`);
    let calls = 0;
    const runtime = new SnarkRouteAtomicAgentRuntime({ execute: async input => {
      calls++;
      if (calls <= 5) {
        expect(input.contextPacket).not.toContain("FINAL VERIFICATION TURN");
        return { response: JSON.stringify({ content: "Inspect another required file", tool_actions: [
          { name: "fs.read", arguments: { path: `file${calls}.ts` } }
        ] }) };
      }
      return { response: JSON.stringify({ content: { verdict: "accepted", summary: "All five required files inspected", evidence: ["Observed five distinct exports"] }, tool_actions: [] }) };
    } });
    const result = await runtime.execute({ taskId: "task", stepId: "step", instruction: "Verify five files", contextPacket: "Inspect all required files",
      rootPath: root, routing: { mode: "fixed", model: "bonsai" }, permissions: "read_only", phase: "verification" });
    expect(JSON.parse(result.response).verdict).toBe("accepted"); expect(calls).toBe(6);
  });
  it("guides a repeated inspection loop into a local repair without external supervision", async () => {
    const root = await workspace(); await writeFile(join(root, "example.ts"), "export const foo = 1;\n");
    let calls = 0;
    const model: SupervisorAgentRuntime = { execute: async input => {
      calls++;
      if (calls <= 3) return { response: JSON.stringify({ content: "Inspect", tool_actions: [{ name: "fs.read", arguments: { path: "example.ts" } }] }) };
      if (calls === 4) {
        expect(input.contextPacket).toContain("Progress stalled");
        return { response: JSON.stringify({ content: "Repair", tool_actions: [{ name: "fs.patch", arguments: { path: "example.ts", old: "foo = 1", new: "foo = 2" } }] }) };
      }
      return { response: JSON.stringify({ content: "Fixed foo", tool_actions: [] }) };
    } };
    const runtime = new SnarkRouteAtomicAgentRuntime(model);
    expect((await runtime.execute({ taskId: "task", stepId: "step", instruction: "Repair foo", contextPacket: "Make foo equal 2",
      rootPath: root, routing: { mode: "fixed", model: "bonsai" }, permissions: "read_write" })).response).toBe("Fixed foo");
    expect(await readFile(join(root, "example.ts"), "utf8")).toContain("foo = 2");
  });
  it("accepts structured verification content after inspecting an actual file", async () => {
    const root = await workspace(); await writeFile(join(root, "example.ts"), "export const foo = 42;\n");
    const replies = [
      { content: "Inspect", tool_actions: [{ name: "fs.read", arguments: { path: "example.ts" } }] },
      { content: { verdict: "accepted", summary: "Actual code inspected", evidence: ["example.ts contains foo = 42"] }, tool_actions: [] }
    ];
    const runtime = new SnarkRouteAtomicAgentRuntime({ execute: async () => ({ response: JSON.stringify(replies.shift()) }) });
    const result = await runtime.execute({ taskId: "task", stepId: "step", instruction: "Verify foo", contextPacket: "Inspect actual state",
      rootPath: root, routing: { mode: "fixed", model: "bonsai" }, permissions: "read_only", phase: "verification" });
    expect(JSON.parse(result.response).verdict).toBe("accepted");
    expect(result.metadata).toMatchObject({ toolCallCount: 1, toolsUsed: ["fs.read"] });
  });
  it("performs search and read inside one Supervisor Step and one Run", async () => {
    const root = await workspace();
    await writeFile(join(root, "example.ts"), "export const foo = 42;\n", "utf8");
    const replies = [
      { content: "Searching", tool_actions: [{ name: "fs.search", arguments: { query: "foo" } }] },
      { content: "Reading", tool_actions: [{ name: "fs.read", arguments: { path: "example.ts" } }] },
      { content: "Found foo in example.ts:1; it equals 42.", tool_actions: [] }
    ];
    const model: SupervisorAgentRuntime = { execute: vi.fn(async () => ({ response: JSON.stringify(replies.shift()) })) };
    const { memory, task, bridge } = fixture(root, model);

    const result = await bridge.supervisorExecuteStep({ taskId: task.id, instruction: "Find foo in the test workspace.",
      routingMode: "fixed", model: "fake-model", runtimeMode: "agent", permissions: "read_only" });

    expect(result).toMatchObject({ status: "completed", response: "Found foo in example.ts:1; it equals 42." });
    expect(model.execute).toHaveBeenCalledTimes(3);
    expect(memory.list_task_steps(task.id)).toHaveLength(1);
    expect(memory.list_runs_for_step(result.stepId)).toHaveLength(1);
    expect(memory.list_runs_for_step(result.stepId)[0]?.metadata).toMatchObject({ runtime: {
      runtimeMode: "agent", permissions: "read_only", toolCallCount: 2, toolsUsed: ["fs.search", "fs.read"], touchedFiles: ["example.ts"]
    } });
    expect(memory.get_step(result.stepId)).toMatchObject({ status: "completed" });
  });

  it("denies a model-requested write in read_only mode without changing the workspace", async () => {
    const root = await workspace();
    const file = join(root, "example.ts");
    await writeFile(file, "original", "utf8");
    const replies = [
      { content: "Attempting write", tool_actions: [{ name: "fs.write", arguments: { path: "example.ts", content: "changed" } }] },
      { content: "Write was denied; workspace unchanged.", tool_actions: [] }
    ];
    const model: SupervisorAgentRuntime = { execute: vi.fn(async (input) => {
      if (replies.length === 1) expect(input.contextPacket).toContain("Tool is denied in read_only mode.");
      return { response: JSON.stringify(replies.shift()) };
    }) };
    const { task, bridge } = fixture(root, model);

    const result = await bridge.supervisorExecuteStep({ taskId: task.id, instruction: "Inspect only.", permissions: "read_only", routingMode: "auto", runtimeMode: "agent" });

    expect(result.status).toBe("completed");
    expect(await readFile(file, "utf8")).toBe("original");
  });

  it("denies a path outside Project.rootPath", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jabberwock-root-test-"));
    directories.push(parent);
    const root = join(parent, "workspace");
    await mkdir(root);
    await writeFile(join(parent, "secret.txt"), "outside", "utf8");
    const replies = [
      { content: "Trying path", tool_actions: [{ name: "fs.read", arguments: { path: "../secret.txt" } }] },
      { content: "Outside path was denied.", tool_actions: [] }
    ];
    const model: SupervisorAgentRuntime = { execute: vi.fn(async (input) => {
      if (replies.length === 1) expect(input.contextPacket).toContain("Path escapes project rootPath.");
      return { response: JSON.stringify(replies.shift()) };
    }) };
    const { task, bridge } = fixture(root, model);

    const result = await bridge.supervisorExecuteStep({ taskId: task.id, instruction: "Read secret.", permissions: "read_only", routingMode: "auto", runtimeMode: "agent" });

    expect(result.status).toBe("completed");
    expect(await readFile(join(parent, "secret.txt"), "utf8")).toBe("outside");
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jabberwock-atomic-test-"));
  directories.push(root);
  return root;
}

function fixture(rootPath: string, model: SupervisorAgentRuntime) {
  const memory = new JabberwockMemoryService(":memory:");
  memories.push(memory);
  const project = memory.create_project({ name: "Test workspace", root_path: rootPath });
  const task = memory.create_task({ project_id: project.id, title: "Find foo", original_request: "Inspect the project." });
  const bridge = new SupervisorBridge(memory, {
    router: { route: vi.fn(async () => ({ mode: "fixed" as const, model: "fake-model", provider: "mock" })) },
    runtime: new SnarkRouteAtomicAgentRuntime(model)
  });
  return { memory, task, bridge };
}
