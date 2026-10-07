import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SnarkRouteAtomicAgentRuntime } from "./atomic-agent-runtime";
import type { SupervisorAgentRuntime } from "./supervisor-bridge";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const answer = (tool_calls: unknown[] = [], content: string | null = null) => ({ response: content ?? "", assistantMessage: { role: "assistant", content, tool_calls } });
async function fixture(replies: unknown[], protocol = "native", permissions = "read_write") {
  const root = await mkdtemp(join(tmpdir(), "native-atomic-test-")); roots.push(root); await writeFile(join(root, "probe.txt"), "unique-before\n");
  const execute = vi.fn(async () => replies.shift() as Awaited<ReturnType<SupervisorAgentRuntime["execute"]>>);
  const runtime = new SnarkRouteAtomicAgentRuntime({ execute });
  const input = { taskId: "task", stepId: "step", instruction: "Read, repair and verify probe.txt", contextPacket: "Small fixture",
    rootPath: root, routing: { mode: "fixed" as const, model: "qwen3:8b", provider: "local_openai" }, permissions, toolProtocol: protocol, maxToolTurns: 8 } as Parameters<typeof runtime.execute>[0];
  return { root, runtime, input, execute };
}

it("roundtrips native read/patch/read with original tool IDs and mutation hashes", async () => {
  const f = await fixture([answer([call("r1", "fs_read", { path: "probe.txt" })]), answer([call("p1", "fs_patch", { path: "probe.txt", old: "unique-before", new: "unique-after" })]), answer([call("r2", "fs_read", { path: "probe.txt" })]), answer([], '{"changed":true}')]);
  const result = await f.runtime.execute(f.input);
  expect(await readFile(join(f.root, "probe.txt"), "utf8")).toBe("unique-after\n");
  expect(result.metadata).toMatchObject({ toolProtocol: "native", modelCalls: 4, toolCallCount: 3, mutationEvents: [expect.objectContaining({ tool: "fs.patch", state: "finished", success: true, beforeHash: expect.any(String), afterHash: expect.any(String) })] });
  const requests = f.execute.mock.calls as unknown as Array<[Parameters<SupervisorAgentRuntime["execute"]>[0]]>;
  expect(requests[0][0].chat?.tools.map(tool => tool.function.name)).toContain("fs_patch");
  expect(requests[0][0].generation?.jsonObject).toBe(false);
  expect(requests[1][0].chat?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "r1" })] }), expect.objectContaining({ role: "tool", tool_call_id: "r1", content: expect.stringContaining("unique-before") })]));
  expect(requests[3][0].chat?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", tool_call_id: "r2", content: expect.stringContaining("unique-after") })]));
});
it("executes multiple calls sequentially and supplies a result for every ID", async () => {
  const f = await fixture([answer([call("one", "fs_read", { path: "probe.txt" }), call("two", "fs_search", { path: "probe.txt", query: "before" })]), answer([], "done")]);
  expect((await f.runtime.execute(f.input)).metadata).toMatchObject({ toolCallCount: 2 });
  const next = (f.execute.mock.calls as unknown as Array<[Parameters<SupervisorAgentRuntime["execute"]>[0]]>)[1][0];
  expect(next.chat?.messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(["one", "two"]);
});
it("does not expose mutation schemas or permit native writes in read_only", async () => {
  const f = await fixture([answer([call("write", "fs_patch", { path: "probe.txt", old: "unique-before", new: "bad" })]), answer([], "denied")], "native", "read_only");
  const result = await f.runtime.execute(f.input);
  expect(await readFile(join(f.root, "probe.txt"), "utf8")).toBe("unique-before\n");
  expect(result.metadata?.toolEvidence).toEqual([expect.objectContaining({ success: false })]);
  const first = (f.execute.mock.calls as unknown as Array<[Parameters<SupervisorAgentRuntime["execute"]>[0]]>)[0][0];
  expect(first.chat?.tools.map(tool => tool.function.name)).not.toContain("fs_patch");
});
it.each(["bad arguments", "duplicate IDs", "unknown tool", "too many calls", "missing assistant", "manual JSON", "empty final"])("fails closed on %s without a JSON/provider fallback or mutation", async kind => {
  const valid = call("ok", "fs_patch", { path: "probe.txt", old: "unique-before", new: "bad" });
  const bad = kind === "bad arguments" ? answer([{ ...valid, function: { name: "fs_patch", arguments: "[broken" } }])
    : kind === "duplicate IDs" ? answer([valid, valid]) : kind === "unknown tool" ? answer([call("x", "exec_arbitrary", {})])
    : kind === "too many calls" ? answer(Array.from({ length: 9 }, (_, n) => call(String(n), "fs_read", { path: "probe.txt" })))
    : kind === "missing assistant" ? { response: '{"content":"done","tool_actions":[]}' }
    : kind === "manual JSON" ? answer([], '{"content":"simulate write","tool_actions":[{"name":"fs.write","arguments":{"path":"probe.txt","content":"bad"}}]}') : answer();
  const f = await fixture([bad]); await expect(f.runtime.execute(f.input)).rejects.toMatchObject({ metadata: { toolProtocol: "native", modelCalls: 1 } });
  expect(f.execute).toHaveBeenCalledTimes(1); expect(await readFile(join(f.root, "probe.txt"), "utf8")).toBe("unique-before\n");
});
it("returns a native final without inventing tools", async () => {
  const f = await fixture([answer([], "No changes required")]); expect((await f.runtime.execute(f.input)).response).toBe("No changes required");
});
it("keeps native coding scope and constraints without repeating the Supervisor evidence ledger", async () => {
  const f = await fixture([answer([], "done")]);
  await f.runtime.execute({ ...f.input, contextPacket: "PROJECT\nDisposable\n\nTASK GOAL\nOnly fix the status label\n\nKNOWN FACTS\nStale repeated evidence\n\nCONSTRAINTS\nPreserve other files\n\nCURRENT INSTRUCTION\nActual instruction" });
  const first = (f.execute.mock.calls as unknown as Array<[Parameters<SupervisorAgentRuntime["execute"]>[0]]>)[0][0];
  const system = first.chat!.messages[0].content!;
  expect(system).toContain("Only fix the status label"); expect(system).toContain("Preserve other files");
  expect(system).not.toContain("Stale repeated evidence"); expect(system).not.toContain("tool_actions");
  expect(first.chat!.messages[1].content).toBe(f.input.instruction);
});
it("honors cancellation before mutation and preserves attempted model accounting", async () => {
  const f = await fixture([]); const controller = new AbortController();
  f.execute.mockImplementation(async () => { controller.abort(new Error("cancelled")); return answer([call("write", "fs_patch", { path: "probe.txt", old: "unique-before", new: "bad" })]); });
  await expect(f.runtime.execute({ ...f.input, signal: controller.signal })).rejects.toMatchObject({ metadata: { modelCalls: 1, toolCallCount: 0 } });
  expect(await readFile(join(f.root, "probe.txt"), "utf8")).toBe("unique-before\n");
});
it("bounds native turns and preserves the mutation journal on exhaustion", async () => {
  const f = await fixture([answer([call("patch", "fs_patch", { path: "probe.txt", old: "unique-before", new: "unique-after" })])]);
  await expect(f.runtime.execute({ ...f.input, maxToolTurns: 1 })).rejects.toMatchObject({ metadata: { modelCalls: 1, maxToolTurnsReached: true, mutationEvents: [expect.objectContaining({ success: true, afterHash: expect.any(String) })] } });
});
it.each([false, true])("auto uses confirmed native capability=%s; otherwise retains JSON", async confirmed => {
  const f = await fixture([confirmed ? answer([], "done") : { response: '{"content":"done","tool_actions":[]}' }], "auto");
  const result = await f.runtime.execute({ ...f.input, routing: { ...f.input.routing, metadata: { nativeToolsConfirmed: confirmed } } });
  expect(result.metadata?.toolProtocol).toBe(confirmed ? "native" : "json");
});
it("native is restricted to the existing local provider", async () => {
  const f = await fixture([]); await expect(f.runtime.execute({ ...f.input, routing: { ...f.input.routing, provider: "openrouter" } })).rejects.toThrow("local_openai"); expect(f.execute).not.toHaveBeenCalled();
});
it("rejects replayed native IDs before another mutation", async () => {
  const patch = answer([call("same-id", "fs_patch", { path: "probe.txt", old: "unique-before", new: "unique-after" })]);
  const f = await fixture([patch, patch]);
  await expect(f.runtime.execute(f.input)).rejects.toMatchObject({ metadata: { modelCalls: 2, toolCallCount: 1, mutationEvents: [expect.objectContaining({ success: true })] } });
  expect(await readFile(join(f.root, "probe.txt"), "utf8")).toBe("unique-after\n");
});
it("retains the journal if the model fails after a successful native mutation", async () => {
  const f = await fixture([answer([call("patch", "fs_patch", { path: "probe.txt", old: "unique-before", new: "unique-after" })])]);
  const first = f.execute.getMockImplementation()!;
  f.execute.mockImplementation(async () => { if (f.execute.mock.calls.length === 1) return first(); throw new Error("interrupted model request"); });
  await expect(f.runtime.execute(f.input)).rejects.toMatchObject({ metadata: { modelCalls: 2, mutationEvents: [expect.objectContaining({ success: true, beforeHash: expect.any(String), afterHash: expect.any(String) })] } });
  expect(await readFile(join(f.root, "probe.txt"), "utf8")).toBe("unique-after\n");
});
