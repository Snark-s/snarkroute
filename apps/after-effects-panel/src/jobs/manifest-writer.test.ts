import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationMetadata, ProjectFileContext } from "../types";
import { generationDirectory, manifestFailureText, type ManifestNodeRuntime, writeGenerationManifest } from "./manifest-writer";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("CEP Node manifest writer", () => {
  it("creates nested directories and atomically writes UTF-8 through tmp + rename", async () => {
    const root = await temporaryRoot();
    const manifestPath = path.join(root, "Проект с пробелами", "SnarkRoute Generations", "результат.mp4.json");
    const runtime = instrumentedRuntime();
    const diagnostic = await writeGenerationManifest(metadata(manifestPath, "Робот встаёт"), runtime.runtime);
    expect(diagnostic).toMatchObject({ ok: true, encoding: "utf8", mkdirResult: "ok", openResult: "ok", writeResult: "ok", closeResult: "ok", renameResult: "ok", finalExists: true });
    expect(runtime.calls).toEqual(expect.arrayContaining([`mkdir:${path.dirname(manifestPath)}`, `open:${manifestPath}.tmp`, `rename:${manifestPath}.tmp->${manifestPath}`]));
    expect(await readFile(manifestPath, "utf8")).toContain("Робот встаёт");
    expect((await stat(manifestPath)).size).toBeGreaterThan(0);
  });

  it("uses APPDATA for an unsaved project", async () => {
    const root = await temporaryRoot();
    const runtime = instrumentedRuntime({ APPDATA: path.join(root, "Пользовательские данные"), TEMP: path.join(root, "Temp") }).runtime;
    expect(await generationDirectory(unsaved(), runtime)).toBe(path.join(root, "Пользовательские данные", "SnarkRoute Generations"));
  });

  it("falls back to TEMP when APPDATA mkdir fails", async () => {
    const root = await temporaryRoot();
    const appData = path.join(root, "Blocked AppData");
    const instrumented = instrumentedRuntime({ APPDATA: appData, TEMP: path.join(root, "Temp") });
    const original = instrumented.runtime.fs.mkdir;
    instrumented.runtime.fs.mkdir = async (target, options) => { if (target.startsWith(appData)) throw Object.assign(new Error("access denied"), { code: "EACCES" }); return original(target, options); };
    expect(await generationDirectory(unsaved(), instrumented.runtime)).toBe(path.join(root, "Temp", "SnarkRoute Generations"));
  });

  it("returns complete Node diagnostics instead of a bare error number", async () => {
    const root = await temporaryRoot();
    const manifestPath = path.join(root, "blocked", "out.json");
    const runtime = instrumentedRuntime().runtime;
    runtime.fs.open = async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };
    const diagnostic = await writeGenerationManifest(metadata(manifestPath), runtime);
    expect(manifestFailureText(diagnostic)).toContain("Node error code: EACCES");
    expect(diagnostic).toMatchObject({ ok: false, directoryExists: true, openResult: "failed: permission denied", nodeErrorMessage: "permission denied" });
  });
});

function instrumentedRuntime(env: Record<string, string> = {}) {
  const calls: string[] = [];
  const runtime: ManifestNodeRuntime = { env, path, fs: {
    async mkdir(target, options) { calls.push(`mkdir:${target}`); return (await import("node:fs/promises")).mkdir(target, options); },
    async open(target, flags) { calls.push(`open:${target}`); return (await import("node:fs/promises")).open(target, flags); },
    async rename(from, to) { calls.push(`rename:${from}->${to}`); return (await import("node:fs/promises")).rename(from, to); },
    async stat(target) { return (await import("node:fs/promises")).stat(target); },
    async unlink(target) { return (await import("node:fs/promises")).unlink(target); }
  } };
  return { runtime, calls };
}
async function temporaryRoot() { const root = await mkdtemp(path.join(tmpdir(), "snarkroute-manifest-")); roots.push(root); return root; }
function unsaved(): ProjectFileContext { return { saved: false, projectFilePath: null, projectDirectory: null, appDataPath: null, tempPath: null }; }
function metadata(manifestPath: string, prompt = "move"): GenerationMetadata { return { jobId: "job_1", modelId: "wan/2.5", provider: "polza", capability: "video.generate", prompt, params: {}, inputs: [], createdAt: "now", estimatedCost: null, actualCost: null, manifestPath, inputFramePath: "C:\\frame.png", inputAssetId: "asset", sourceCompositionId: 1, sourceCompositionName: "Comp", sourceTime: 0, placeholderCreatedAt: "now", jobCreatedAt: "now" }; }
