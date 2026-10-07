import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedVerifierRuntime } from "./bounded-verifier";
import { inspectVerificationPolicy } from "./verification-policy";
import { AtomicWorkspaceTools } from "./atomic-tools";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function workspace() { const root = await mkdtemp(join(tmpdir(), "bounded-verifier-")); roots.push(root); await writeFile(join(root, "code.ts"), "export const value = 1;\n"); return root; }
const input = (rootPath: string) => ({ taskId: "task", stepId: "step", instruction: "Verify value equals 1", contextPacket: "DO NOT COPY THIS WHOLE TASK HISTORY", rootPath, routing: { mode: "fixed" as const, model: "bonsai" }, permissions: "read_write" as const, phase: "verification" as const });

describe("bounded read-only verifier", () => {
  it("finishes with accepted/rejected/unknown and preserves counterevidence", async () => {
    const root = await workspace();
    for (const verdict of ["accepted", "rejected", "unknown"] as const) {
      let calls = 0;
      const runtime = new BoundedVerifierRuntime({ execute: async request => {
        calls++; expect(request.permissions).toBe("read_only"); expect(request.contextPacket).not.toContain("WHOLE TASK HISTORY");
        expect(request.generation).toEqual({ maxTokens: 768, temperature: 0, jsonObject: true });
        return { response: JSON.stringify(calls === 1 ? { tool_actions: [{ name: "fs.read", arguments: { path: "code.ts" } }] }
          : { verdict, reason: "Actual source inspected", evidence: ["value is 1"], counterevidence: verdict === "rejected" ? ["Required call missing"] : [] }) };
      } });
      const result = await runtime.execute(input(root));
      expect(JSON.parse(result.response).verdict).toBe(verdict); expect(result.metadata).toMatchObject({ boundedVerifier: true, modelCalls: 2, toolCallCount: 1 });
    }
  });
  it("terminates after three model calls and six read tools, with unknown rather than acceptance", async () => {
    const root = await workspace(); let calls = 0;
    const runtime = new BoundedVerifierRuntime({ execute: async request => {
      calls++; if (calls === 3) expect(request.contextPacket).toContain("FINAL VERDICT");
      return { response: JSON.stringify({ tool_actions: Array.from({ length: 8 }, () => ({ name: "fs.read", arguments: { path: "code.ts" } })) }) };
    } });
    const result = await runtime.execute(input(root));
    expect(JSON.parse(result.response).verdict).toBe("unknown"); expect(calls).toBe(3);
    expect(result.metadata).toMatchObject({ toolCallCount: 6 });
  });
  it("never accepts a contradictory accepted verdict and cannot write", async () => {
    const root = await workspace(); let calls = 0;
    const runtime = new BoundedVerifierRuntime({ execute: async () => ({ response: JSON.stringify(++calls === 1
      ? { tool_actions: [{ name: "fs.patch", arguments: { path: "code.ts", old: "1", new: "2" } }, { name: "fs.read", arguments: { path: "code.ts" } }] }
      : { verdict: "accepted", reason: "Done", evidence: ["Actual read"], counterevidence: ["Missing lifecycle listener"] }) }) });
    expect(JSON.parse((await runtime.execute(input(root))).response).verdict).toBe("rejected");
    expect(await readFile(join(root, "code.ts"), "utf8")).toContain("value = 1");
  });
  it("propagates cancellation without an accepted verdict", async () => {
    const root = await workspace(); const controller = new AbortController();
    const runtime = new BoundedVerifierRuntime({ execute: async request => { controller.abort(); throw request.signal!.reason; } });
    await expect(runtime.execute({ ...input(root), signal: controller.signal })).rejects.toThrow();
  });
  it("uses AST call sites rather than declarations, comments or strings", async () => {
    const root = await workspace();
    await writeFile(join(root, "code.ts"), 'function active() {}\n// active()\nconst text = "active()";\n');
    const tools = await AtomicWorkspaceTools.create(root, "read_only");
    const policy = { stepIndex: 0, sources: [{ path: "code.ts", uniqueSymbol: "active", requiredCalls: ["active"] }] };
    const missing = await inspectVerificationPolicy(tools, policy, []);
    expect(missing.counterevidence.join(" ")).toContain("0 actual calls");
    await writeFile(join(root, "code.ts"), "function active() {}\nactive();\n");
    expect((await inspectVerificationPolicy(tools, policy, [])).counterevidence).toEqual([]);
  });
  it("requires a real successful process receipt for build", async () => {
    const root = await workspace(); const tools = await AtomicWorkspaceTools.create(root, "read_only");
    const policy = { stepIndex: 0, requiredCommands: ["build" as const] };
    expect((await inspectVerificationPolicy(tools, policy, [{ summary: "Build passed", exitCode: 0 }])).counterevidence).not.toEqual([]);
    const receipt = { source: "package_process", script: "build", success: true, command: "corepack pnpm run build", exitCode: 0, durationMs: 12, stdoutSummary: "built", stderrSummary: "" };
    expect((await inspectVerificationPolicy(tools, policy, [receipt])).counterevidence).toEqual([]);
    expect((await inspectVerificationPolicy(tools, policy, [{ ...receipt, success: false }])).counterevidence).not.toEqual([]);
  });
});
