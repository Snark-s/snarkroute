import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicWorkspaceTools } from "./atomic-tools";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "jabberwock-tools-")); directories.push(root); return root; }
describe("atomic workspace safety", () => {
  it("verifies real before/after hashes for an interrupted write", async () => {
    const root = await fixture(); await writeFile(join(root, "file.txt"), "before");
    const tools = await AtomicWorkspaceTools.create(root, "read_write");
    const call = { name: "fs.write", arguments: { path: "file.txt", content: "one code block" } };
    const intent = (await tools.mutationIntent(call))!;
    expect(await tools.verifyMutation(intent)).toBe("unchanged");
    await tools.execute(call); expect(await tools.verifyMutation(intent)).toBe("applied");
    await writeFile(join(root, "file.txt"), "unexpected content"); expect(await tools.verifyMutation(intent)).toBe("unknown");
  });
  it("reads a targeted line range", async () => {
    const root = await fixture(); await writeFile(join(root, "file.txt"), "one\ntwo\nthree\nfour");
    const tools = await AtomicWorkspaceTools.create(root, "read_only");
    expect(await tools.execute({ name: "fs.read", arguments: { path: "file.txt", startLine: 2, endLine: 3 } })).toMatchObject({ success: true, output: "two\nthree" });
  });
  it("runs the allowlisted package script through the owned IPC worker", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "node -e \"console.log('built')\"" }, packageManager: "pnpm@9.1.0" }));
    const tools = await AtomicWorkspaceTools.create(root, "read_write");
    expect(await tools.execute({ name: "shell.exec", arguments: { script: "build" } })).toMatchObject({ success: true, exitCode: 0, output: expect.stringContaining("built"),
      source: "package_process", script: "build", command: "corepack pnpm run build", durationMs: expect.any(Number),
      stdoutSummary: expect.stringContaining("built"), stderrSummary: "" });
  }, 20_000);
  it("kills a running script and its children before returning from cancellation", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { build: "node wait.cjs" }, packageManager: "pnpm@9.1.0" }));
    await writeFile(join(root, "wait.cjs"), "require('node:fs').writeFileSync('started.txt','yes');setInterval(()=>require('node:fs').appendFileSync('ticks.txt','x'),50)");
    const tools = await AtomicWorkspaceTools.create(root, "read_write"); const controller = new AbortController();
    const running = tools.execute({ name: "shell.exec", arguments: { script: "build" } }, controller.signal);
    await vi.waitFor(async () => expect(await readFile(join(root, "started.txt"), "utf8")).toBe("yes"), { timeout: 10_000 });
    controller.abort(new Error("Cancel route"));
    await expect(running).rejects.toThrow("Cancel route");
    let before = ""; try { before = await readFile(join(root, "ticks.txt"), "utf8"); } catch { /* cancelled before the first tick */ }
    await new Promise(resolve => setTimeout(resolve, 150));
    let after = ""; try { after = await readFile(join(root, "ticks.txt"), "utf8"); } catch { /* cancelled before the first tick */ }
    expect(after).toBe(before);
  }, 20_000);
  it("terminates script descendants when the Supervisor parent exits unexpectedly", async () => {
    const root = await fixture();
    const workerPath = fileURLToPath(new URL("../../../../scripts/jabberwock-script-worker.mjs", import.meta.url));
    await writeFile(join(root, "wait.cjs"), "require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},50)");
    const parentPath = join(root, "parent.mjs");
    await writeFile(parentPath, `import {fork} from 'node:child_process';\nconst worker=fork(${JSON.stringify(workerPath)},[],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});\nworker.send({type:'run',command:process.execPath,argv:['wait.cjs'],cwd:${JSON.stringify(root)}});`);
    const parent = spawn(process.execPath, [parentPath], { windowsHide: true, stdio: "ignore" });
    try {
      let scriptPid = 0;
      await vi.waitFor(async () => { scriptPid = Number(await readFile(join(root, "child.pid"), "utf8")); expect(scriptPid).toBeGreaterThan(0); }, { timeout: 10_000 });
      parent.kill();
      await vi.waitFor(() => expect(() => process.kill(scriptPid, 0)).toThrow(), { timeout: 10_000 });
    } finally { parent.kill(); }
  }, 20_000);
});
