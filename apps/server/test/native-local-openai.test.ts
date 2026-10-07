import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SnarkRouteAtomicAgentRuntime } from "../src/jabberwock-memory/atomic-agent-runtime";
import { SnarkRouteAtomicTextRuntime } from "../src/jabberwock-memory/supervisor-bridge";

it("forwards native tools/messages through Model Gateway/local adapter and preserves assistant/tool IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-provider-test-"));
  await writeFile(join(root, "probe.txt"), "transport-marker");
  vi.stubEnv("LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON", JSON.stringify([{ baseUrl: "http://127.0.0.1:11434/v1", modelIds: ["qwen3:8b"], nativeToolModelIds: ["qwen3:8b"], reasoningEffort: "none" }]));
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null,
    tool_calls: [{ id: "native-read-id", type: "function", function: { name: "fs_read", arguments: '{"path":"probe.txt"}' } }] } }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Read transport-marker" } }] })));
  try {
    const runtime = new SnarkRouteAtomicAgentRuntime(new SnarkRouteAtomicTextRuntime());
    const result = await runtime.execute({ taskId: "task", stepId: "step", instruction: "Read probe.txt", contextPacket: "fixture", rootPath: root,
      routing: { mode: "fixed", model: "qwen3:8b", providerModelId: "qwen3:8b", provider: "local_openai" }, toolProtocol: "native", permissions: "read_only" });
    expect(result.response).toBe("Read transport-marker"); expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)); const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(first).toMatchObject({ model: "qwen3:8b", tool_choice: "auto", max_tokens: 2048, reasoning_effort: "none" });
    expect(first.response_format).toBeUndefined();
    expect(first.tools).toContainEqual(expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "fs_read", parameters: expect.objectContaining({ type: "object", required: ["path"] }) }) }));
    expect(first.tools.map((tool: { function: { name: string } }) => tool.function.name)).not.toContain("fs_patch");
    expect(second.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "native-read-id", content: expect.stringContaining("transport-marker") }));
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
