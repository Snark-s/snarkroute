import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SnarkRouteAtomicAgentRuntime } from "./atomic-agent-runtime";
import type { SupervisorAgentRuntime } from "./supervisor-bridge";

describe("atomic agent cancellation", () => {
  it("passes the Supervisor signal into the model call and stops the loop on abort", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "jabberwock-cancel-test-"));
    const controller = new AbortController();
    const model: SupervisorAgentRuntime = {
      execute: vi.fn(async (input) => {
        expect(input.signal).toBe(controller.signal);
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
        });
        return { response: "unreachable" };
      })
    };
    const runtime = new SnarkRouteAtomicAgentRuntime(model);
    const execution = runtime.execute({
      taskId: "task",
      stepId: "step",
      instruction: "One atomic action",
      contextPacket: "Bounded Supervisor context",
      routing: { mode: "fixed", model: "bonsai", provider: "local_openai" },
      rootPath,
      permissions: "read_only",
      signal: controller.signal
    });
    await vi.waitFor(() => expect(model.execute).toHaveBeenCalledTimes(1));
    controller.abort(new Error("Supervisor timed out"));

    await expect(execution).rejects.toThrow("Supervisor timed out");
    expect(model.execute).toHaveBeenCalledTimes(1);
    await rm(rootPath, { recursive: true, force: true });
  });
});
