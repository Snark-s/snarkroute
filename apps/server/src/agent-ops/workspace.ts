import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { CheckResult, TaskCheck, WorkspaceSnapshot } from "./types";

const execFileAsync = promisify(execFile);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", ".next"]);
const MAX_FILES = 5000;

async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}

export async function gitTopLevel(dir: string): Promise<string | undefined> {
  try { return resolve((await git(dir, ["rev-parse", "--show-toplevel"])).trim()); } catch { return undefined; }
}

/** What the folder looks like now: git status with content hashes of dirty files, or size/mtime of plain files. */
export async function snapshotWorkspace(dir: string | undefined): Promise<WorkspaceSnapshot> {
  const capturedAt = new Date().toISOString();
  if (!dir) return { kind: "none", entries: {}, capturedAt };
  if (await gitTopLevel(dir)) {
    const head = await git(dir, ["rev-parse", "HEAD"]).then(value => value.trim()).catch(() => undefined);
    const status = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => "");
    const entries: Record<string, string> = {};
    const parts = status.split("\0").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const code = parts[index].slice(0, 2);
      const path = parts[index].slice(3);
      if (code.startsWith("R") || code.startsWith("C")) index += 1;
      if (Object.keys(entries).length >= 500) return { kind: "git", head, entries, capturedAt, truncated: true };
      entries[path] = `${code}:${await fileHash(join(dir, path))}`;
    }
    return { kind: "git", head, entries, capturedAt };
  }
  const entries: Record<string, string> = {};
  let truncated = false;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (Object.keys(entries).length >= MAX_FILES) { truncated = true; return; }
      const full = join(current, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) await walk(full); continue; }
      const info = await stat(full).catch(() => undefined);
      if (info) entries[relative(dir, full)] = `${info.size}:${Math.round(info.mtimeMs)}`;
    }
  };
  await walk(dir);
  return { kind: "files", entries, capturedAt, truncated };
}

async function fileHash(path: string): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return "dir";
    if (info.size > 8 * 1024 * 1024) return `big:${info.size}:${Math.round(info.mtimeMs)}`;
    return createHash("sha1").update(await readFile(path)).digest("hex").slice(0, 16);
  } catch { return "missing"; }
}

/** Paths that differ between two snapshots; a moved HEAD (new commit) counts as a change. */
export function changedPaths(before: WorkspaceSnapshot | undefined, after: WorkspaceSnapshot): string[] {
  if (!before) return Object.keys(after.entries);
  const changed = new Set<string>();
  for (const [path, value] of Object.entries(after.entries)) if (before.entries[path] !== value) changed.add(path);
  for (const path of Object.keys(before.entries)) if (!(path in after.entries)) changed.add(path);
  if (before.kind === "git" && after.kind === "git" && before.head !== after.head) changed.add(`(HEAD ${before.head?.slice(0, 8) ?? "none"} → ${after.head?.slice(0, 8) ?? "none"})`);
  return [...changed].sort();
}

export async function createWorktree(repo: string, path: string, branch: string): Promise<void> {
  await git(repo, ["worktree", "add", "-b", branch, path, "HEAD"], 120_000);
}

function insideWorkdir(workdir: string, path: string): string {
  const target = isAbsolute(path) ? resolve(path) : resolve(workdir, path);
  const rel = relative(resolve(workdir), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Путь проверки вне рабочей папки: ${path}`);
  return target;
}

/** Runs one acceptance check in the task's folder. Commands come only from the submitted contract, never from executor output. */
export async function runCheck(check: TaskCheck, workdir: string | undefined, signal?: AbortSignal): Promise<CheckResult> {
  const startedAt = Date.now();
  const done = (ok: boolean, detail: string): CheckResult => ({ check, ok, detail: detail.slice(-4000), durationMs: Date.now() - startedAt });
  try {
    if (check.type === "file_exists") {
      if (!workdir) return done(false, "Нет рабочей папки.");
      const info = await stat(insideWorkdir(workdir, check.path)).catch(() => undefined);
      return done(Boolean(info), info ? "Файл существует." : "Файл не найден.");
    }
    if (check.type === "file_contains") {
      if (!workdir) return done(false, "Нет рабочей папки.");
      const text = await readFile(insideWorkdir(workdir, check.path), "utf8").catch(() => undefined);
      return done(Boolean(text?.includes(check.text)), text === undefined ? "Файл не найден." : text.includes(check.text) ? "Текст найден." : "Текст не найден.");
    }
    const timeoutMs = Math.min(Math.max(check.timeoutMs ?? 120_000, 1000), 15 * 60_000);
    const needsShell = process.platform === "win32" && /^(npm|pnpm|npx|yarn)$|\.(cmd|bat)$/i.test(check.command);
    return await new Promise<CheckResult>(resolvePromise => {
      const child = spawn(check.command, check.args ?? [], { cwd: workdir, shell: needsShell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" } });
      let output = "";
      const append = (chunk: unknown) => { output = (output + String(chunk)).slice(-16_000); };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      const kill = () => { if (child.pid) killProcessTree(child.pid); };
      const timer = setTimeout(() => { output += `\n[timeout ${timeoutMs} ms]`; kill(); }, timeoutMs);
      signal?.addEventListener("abort", kill, { once: true });
      child.once("error", error => { clearTimeout(timer); resolvePromise(done(false, `Команда не запустилась: ${error.message}`)); });
      child.once("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", kill); resolvePromise(done(code === 0, `exit ${code}\n${output}`)); });
    });
  } catch (error) {
    return done(false, error instanceof Error ? error.message : String(error));
  }
}

/** Only for process ids SnarkRoute itself spawned and recorded. */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  else { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
}

/** True when the pid exists and still runs the image we started (guards against pid reuse). */
export async function processAlive(pid: number | undefined, expectedImage?: string): Promise<boolean> {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return false; }
  if (process.platform !== "win32" || !expectedImage) return true;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/fo", "csv", "/nh"], { windowsHide: true, timeout: 4000, encoding: "utf8" });
    const image = /^"([^"]+)"/.exec(stdout.trim())?.[1]?.toLowerCase();
    return Boolean(image && image.replace(/\.exe$/, "") === expectedImage.toLowerCase().replace(/\.exe$/, ""));
  } catch { return true; }
}

export async function processImage(pid: number): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/fo", "csv", "/nh"], { windowsHide: true, timeout: 4000, encoding: "utf8" });
    return /^"([^"]+)"/.exec(stdout.trim())?.[1];
  } catch { return undefined; }
}
