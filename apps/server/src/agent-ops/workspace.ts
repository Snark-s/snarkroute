import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
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
  // A subfolder must not snapshot unrelated files from its parent repository.
  if (await gitTopLevel(dir) === resolve(dir)) {
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

/** Evidence for the acceptance reviewer: the diff of a git folder, or excerpts of changed plain files. */
export async function collectDiff(workdir: string | undefined, changedFiles: string[], limit = 14_000): Promise<string> {
  if (!workdir || !changedFiles.length) return "";
  const parts: string[] = [];
  if (await gitTopLevel(workdir)) {
    parts.push(await git(workdir, ["diff", "HEAD", "--stat"]).catch(() => ""));
    parts.push(await git(workdir, ["diff", "HEAD"]).catch(() => ""));
    const untracked = (await git(workdir, ["ls-files", "--others", "--exclude-standard"]).catch(() => "")).split(/\r?\n/).filter(Boolean).slice(0, 10);
    for (const file of untracked) parts.push(`--- new file ${file}\n${(await readFile(join(workdir, file), "utf8").catch(() => "")).slice(0, 3000)}`);
  } else {
    for (const file of changedFiles.slice(0, 10)) parts.push(`--- ${file}\n${(await readFile(join(workdir, file), "utf8").catch(() => "(not readable)")).slice(0, 3000)}`);
  }
  return parts.join("\n").slice(0, limit);
}

/** Pages may mix UTF-8 with a legacy single-byte encoding (FL.ru serves both): decode line by line, never across chunk borders. */
function decodeBody(raw: Buffer): string {
  const strict = new TextDecoder("utf-8", { fatal: true }), legacy = new TextDecoder("windows-1251");
  const lines: string[] = []; let start = 0;
  for (let index = 0; index <= raw.length; index++) {
    if (index < raw.length && raw[index] !== 10) continue;
    const line = raw.subarray(start, index);
    try { lines.push(strict.decode(line)); } catch { lines.push(legacy.decode(line)); }
    start = index + 1;
  }
  return lines.join("\n");
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
  let outputTruncated = false;
  const done = (ok: boolean, detail: string, content?: string): CheckResult => ({ check, ok, detail: detail.slice(-4000), content: content?.slice(0, 12000), truncated: outputTruncated || (content?.length ?? 0) > 12000, durationMs: Date.now() - startedAt, observedAt: new Date().toISOString(), source: JSON.stringify(check) });
  try {
    if (signal?.aborted) return done(false, "Проверка отменена.");
    if (check.type === "tool" || check.type === "tool_used" || check.type === "tool_observations" || check.type === "acceptor_cycle" || check.type === "tool_scope" || check.type === "task_verified") return done(false, "Проверка инструмента требует общего agent-ops контекста.");
    if (check.type === "http") {
      const url = new URL(check.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return done(false, "Разрешены только HTTP(S) URL без учётных данных.");
      // The contract authorizes this exact read. Redirects cannot silently expand scope.
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(Math.min(check.timeoutMs ?? 10000, 60000))]) });
      const reader = response.body?.getReader(); const chunks: Buffer[] = []; let bytes = 0;
      if (reader) try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 1024 * 1024) throw new Error("Ответ проверки больше 1 МБ."); chunks.push(Buffer.from(chunk.value)); } } finally { await reader.cancel().catch(() => undefined); }
      const body = decodeBody(Buffer.concat(chunks));
      let ok = response.status === (check.status ?? 200);
      if (check.text !== undefined) ok &&= body.includes(check.text);
      if (check.absentText !== undefined) ok &&= !body.includes(check.absentText);
      if (check.pattern !== undefined) {
        const found = [...body.matchAll(new RegExp(check.pattern, "g"))].slice(0, 5000).map(match => match[1] ?? match[0]);
        const count = check.matches?.distinct ? new Set(found).size : found.length;
        ok &&= count >= (check.matches?.min ?? 1) && count <= (check.matches?.max ?? Infinity);
      }
      if (check.json) { let value: any = JSON.parse(body); for (const part of check.json.path.split(".")) value = value?.[part]; ok &&= value === check.json.equals; }
      return done(ok, `HTTP ${response.status}; ${ok ? "условия подтверждены" : "условия не подтверждены"}`, body);
    }
    if (check.type === "process") return done(await processAlive(check.pid, check.image), `process ${check.pid}${check.image ? ` (${check.image})` : ""}`);
    if (check.type === "file_exists" || check.type === "file_contains" || check.type === "file_content" || check.type === "image") {
      if (!workdir) return done(false, "Нет рабочей папки.");
      const path = insideWorkdir(workdir, check.path);
      const canonical = await realpath(path).catch(() => undefined);
      if (!canonical) return done(false, "Файл не найден.");
      insideWorkdir(await realpath(workdir), canonical);
      const info = await stat(canonical);
      if (!info.isFile()) return done(false, "Ожидался файл.");
      if (check.type === "file_exists") return done(true, "Файл существует; содержимое этим не проверено.");
      if(check.type==="image"){
        if(info.size>8*1024*1024)return done(false,"Изображение больше 8 МБ.");const data=await readFile(canonical),mime=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png":data[0]===255&&data[1]===216&&data[2]===255?"image/jpeg":undefined;
        if(!mime)return done(false,"Нужен настоящий PNG или JPEG.");const imageInput={path:canonical,sha256:createHash("sha256").update(data).digest("hex"),mime} as const;return{...done(true,"Изображение прочитано для независимой мультимодальной проверки; качество оценивает модель.",JSON.stringify({...imageInput,bytes:info.size})),imageInput};
      }
      if (info.size > 1024 * 1024) return done(false, "Файл больше 1 МБ; нужна специализированная проверка содержимого.");
      const text = await readFile(canonical, "utf8");
      const ok = check.type === "file_content" ? Boolean(text.trim()) : text.includes(check.text);
      return done(ok, ok ? "Содержимое прочитано; условие выполнено." : "Условие содержимого не выполнено.", text);
    }
    const timeoutMs = Math.min(Math.max(check.timeoutMs ?? 120_000, 1000), 15 * 60_000);
    const needsShell = process.platform === "win32" && /^(npm|pnpm|npx|yarn)$|\.(cmd|bat)$/i.test(check.command);
    return await new Promise<CheckResult>(resolvePromise => {
      const { SNARKROUTE_LAUNCHER_TOKEN: _launcher, SNARKROUTE_MCP_TOKEN: _mcp, ...env } = process.env;
      const child = spawn(check.command, check.args ?? [], { cwd: workdir, shell: needsShell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...env, CI: "1", NO_COLOR: "1" } });
      let output = "";
      let interrupted = false;
      const append = (chunk: unknown) => { const next = output + String(chunk); outputTruncated ||= next.length > 12000; output = next.slice(-16_000); };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      const kill = () => { interrupted = true; if (child.pid) killProcessTree(child.pid); };
      const timer = setTimeout(() => { output += `\n[timeout ${timeoutMs} ms]`; kill(); }, timeoutMs);
      signal?.addEventListener("abort", kill, { once: true });
      child.once("error", error => { clearTimeout(timer); resolvePromise(done(false, `Команда не запустилась: ${error.message}`)); });
      child.once("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", kill); resolvePromise(done(code === 0 && !interrupted, `exit ${code}\n${output}`, `exit ${code}\n${output}`)); });
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
