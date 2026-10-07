import { execFile, fork, type ForkOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const maxOutput = 32_000;
const maxReadBytes = 1_000_000;
const skippedDirectories = new Set([".git", "node_modules", "dist", "build", "graphify-out"]);
export type AtomicPermissions = "read_only" | "read_write";
export type AtomicToolCall = { name: string; arguments: Record<string, unknown> };
export type AtomicToolResult = { name: string; success: boolean; output?: string; error?: string; path?: string; exitCode?: number;
  source?: "package_process"; script?: string; command?: string; durationMs?: number; stdoutSummary?: string; stderrSummary?: string };
export type MutationIntent = { tool: string; path?: string; beforeHash?: string | null; afterHash?: string };

export class AtomicWorkspaceTools {
  private constructor(readonly rootPath: string, readonly permissions: AtomicPermissions) {}

  static async create(rootPath: string, permissions: AtomicPermissions): Promise<AtomicWorkspaceTools> {
    const root = await realpath(rootPath);
    if (!(await stat(root)).isDirectory()) throw new Error("Project rootPath is not a directory.");
    return new AtomicWorkspaceTools(root, permissions);
  }

  definitions(): Array<{ name: string; description: string; arguments: string }> {
    const tools = [
      { name: "fs.list", description: "List a directory inside the project.", arguments: '{"path":"relative directory"}' },
      { name: "fs.search", description: "Search UTF-8 files for a literal string inside the project.", arguments: '{"query":"text","path":"optional relative directory"}' },
      { name: "fs.read", description: "Read a UTF-8 file. Optional startLine/endLine are 1-based integer numbers; use ranges for long files.", arguments: '{"path":"relative file","startLine":1,"endLine":80}' },
      { name: "git.status", description: "Read git status; does not change files.", arguments: "{}" },
      { name: "git.diff", description: "Read unstaged git diff; does not change files.", arguments: "{}" }
    ];
    if (this.permissions === "read_write") tools.push(
      { name: "fs.write", description: "Atomically write a UTF-8 file inside the project.", arguments: '{"path":"relative file","content":"text"}' },
      { name: "fs.patch", description: "Replace one exact occurrence in a project file.", arguments: '{"path":"relative file","old":"text","new":"text"}' },
      { name: "shell.exec", description: "Run an allowlisted project package script: test, build, lint, or typecheck.", arguments: '{"script":"test|build|lint|typecheck","cwd":"optional relative directory"}' }
    );
    return tools;
  }

  /** Record the intended file state before yielding to a potentially mutating tool. */
  async mutationIntent(call: AtomicToolCall): Promise<MutationIntent | null> {
    if (this.permissions !== "read_write") return null;
    if (call.name === "shell.exec") return { tool: call.name };
    if (!["fs.write", "fs.patch"].includes(call.name)) return null;
    const path = await this.path(call.arguments.path, call.name === "fs.write");
    let original: string | null = null;
    try { original = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const after = call.name === "fs.write" ? call.arguments.content
      : original !== null && typeof call.arguments.old === "string" && original.split(call.arguments.old).length === 2
        ? original.replace(call.arguments.old, String(call.arguments.new)) : undefined;
    return { tool: call.name, path: this.display(path), beforeHash: original === null ? null : hash(original),
      ...(typeof after === "string" ? { afterHash: hash(after) } : {}) };
  }

  async verifyMutation(intent: MutationIntent): Promise<"applied" | "unchanged" | "unknown"> {
    if (!intent.path || !intent.afterHash) return "unknown";
    try {
      const path = await this.path(intent.path, true);
      let current: string | null = null;
      try { current = hash(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return current === intent.afterHash ? "applied" : current === intent.beforeHash ? "unchanged" : "unknown";
    } catch { return "unknown"; }
  }

  async execute(call: AtomicToolCall, signal?: AbortSignal): Promise<AtomicToolResult> {
    throwIfAborted(signal);
    const name = call.name;
    const args = call.arguments;
    if (!["fs.list", "fs.search", "fs.read", "git.status", "git.diff", "fs.write", "fs.patch", "shell.exec"].includes(name)) {
      return { name, success: false, error: "Tool is not allowlisted." };
    }
    if (this.permissions === "read_only" && ["fs.write", "fs.patch", "shell.exec"].includes(name)) {
      return { name, success: false, error: "Tool is denied in read_only mode." };
    }
    try {
      switch (name) {
        case "fs.list": return await this.list(args);
        case "fs.search": return await this.search(args, signal);
        case "fs.read": return await this.read(args);
        case "fs.write": return await this.write(args);
        case "fs.patch": return await this.patch(args);
        case "git.status": return await this.git(name, ["status", "--short", "--branch", "--", "."], signal);
        case "git.diff": return await this.git(name, ["diff", "--no-ext-diff", "--", "."], signal);
        case "shell.exec": return await this.script(args, signal);
      }
    } catch (error) {
      throwIfAborted(signal);
      return { name, success: false, error: bounded(error instanceof Error ? error.message : String(error), 1_000) };
    }
    return { name, success: false, error: "Tool is not allowlisted." };
  }

  private inside(path: string): boolean {
    const difference = relative(this.rootPath, path);
    return difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
  }

  private async path(value: unknown, allowMissing = false): Promise<string> {
    if (typeof value !== "string" || !value.trim()) throw new Error("path must be a non-empty string.");
    const candidate = resolve(this.rootPath, value);
    if (!this.inside(candidate)) throw new Error("Path escapes project rootPath.");
    if (!allowMissing) {
      const actual = await realpath(candidate);
      if (!this.inside(actual)) throw new Error("Path escapes project rootPath through a symlink.");
      return actual;
    }
    const parent = await realpath(resolve(candidate, ".."));
    if (!this.inside(parent)) throw new Error("Path escapes project rootPath through a symlink.");
    try { if (!this.inside(await realpath(candidate))) throw new Error("Path escapes project rootPath through a symlink."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return join(parent, relative(resolve(candidate, ".."), candidate));
  }

  private display(path: string): string { return relative(this.rootPath, path).replaceAll("\\", "/") || "."; }

  private async list(args: Record<string, unknown>): Promise<AtomicToolResult> {
    const directory = await this.path(args.path ?? ".");
    if (!(await stat(directory)).isDirectory()) throw new Error("path is not a directory.");
    const entries = (await readdir(directory, { withFileTypes: true })).slice(0, 250).map((entry) => ({
      path: this.display(join(directory, entry.name)), type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file"
    }));
    return { name: "fs.list", success: true, output: bounded(JSON.stringify(entries)) };
  }

  private async search(args: Record<string, unknown>, signal?: AbortSignal): Promise<AtomicToolResult> {
    const query = args.query;
    if (typeof query !== "string" || !query || query.length > 500) throw new Error("query must be 1–500 characters.");
    const start = await this.path(args.path ?? ".");
    const pending = [start];
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let files = 0;
    while (pending.length && files < 3_000 && matches.length < 100) {
      throwIfAborted(signal);
      const current = pending.pop()!;
      const details = await stat(current);
      if (details.isDirectory()) {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || (entry.isDirectory() && skippedDirectories.has(entry.name))) continue;
          pending.push(join(current, entry.name));
        }
        continue;
      }
      if (!details.isFile() || details.size > maxReadBytes) continue;
      files++;
      let content: string;
      try { content = await readFile(current, "utf8"); } catch { continue; }
      if (content.includes("\0")) continue;
      for (const [index, line] of content.split(/\r?\n/u).entries()) {
        if (line.toLowerCase().includes(query.toLowerCase())) matches.push({ path: this.display(current), line: index + 1, text: line.slice(0, 500) });
        if (matches.length >= 100) break;
      }
    }
    return { name: "fs.search", success: true, output: bounded(JSON.stringify({ matches, filesScanned: files, clipped: pending.length > 0 || matches.length >= 100 })) };
  }

  async readForVerification(relativePath: string): Promise<{ content: string; hash: string }> {
    const path = await this.path(relativePath);
    const details = await stat(path);
    if (!details.isFile() || details.size > maxReadBytes) throw new Error("Verification source exceeds the 1 MB read limit.");
    const content = await readFile(path, "utf8");
    return { content, hash: hash(content) };
  }

  private async read(args: Record<string, unknown>): Promise<AtomicToolResult> {
    const path = await this.path(args.path);
    const details = await stat(path);
    if (!details.isFile() || details.size > maxReadBytes) throw new Error("File is missing or exceeds the 1 MB read limit.");
    const content = await readFile(path, "utf8");
    const start = args.startLine ?? 1;
    const end = args.endLine ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 1 || Number(end) < Number(start)) throw new Error("Invalid line range.");
    return { name: "fs.read", success: true, output: bounded(content.split(/\r?\n/u).slice(Number(start) - 1, Number(end)).join("\n")), path: this.display(path) };
  }

  private async write(args: Record<string, unknown>): Promise<AtomicToolResult> {
    if (typeof args.content !== "string" || args.content.length > 250_000) throw new Error("content must be text up to 250 KB.");
    const path = await this.path(args.path, true);
    const temporary = join(resolve(path, ".."), `.jabberwock-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, args.content, { encoding: "utf8", flag: "wx" });
      await rename(temporary, path);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(temporary, { force: true });
    }
    return { name: "fs.write", success: true, output: this.display(path), path: this.display(path) };
  }

  private async patch(args: Record<string, unknown>): Promise<AtomicToolResult> {
    if (typeof args.old !== "string" || !args.old || typeof args.new !== "string") throw new Error("old and new must be strings; old must not be empty.");
    const path = await this.path(args.path);
    if ((await stat(path)).size > maxReadBytes) throw new Error("File exceeds the 1 MB patch limit.");
    const original = await readFile(path, "utf8");
    if (original.split(args.old).length !== 2) throw new Error("old text must occur exactly once.");
    return this.write({ path, content: original.replace(args.old, args.new) });
  }

  private async git(name: string, args: string[], signal?: AbortSignal): Promise<AtomicToolResult> {
    const result = await execFileAsync("git", ["-C", this.rootPath, ...args], { timeout: 30_000, maxBuffer: maxOutput, windowsHide: true, signal });
    if (name === "git.diff") {
      const untracked = await execFileAsync("git", ["-C", this.rootPath, "ls-files", "--others", "--exclude-standard", "--", "."],
        { timeout: 30_000, maxBuffer: maxOutput, windowsHide: true, signal });
      return { name, success: true, output: bounded(result.stdout + (untracked.stdout ? `\nUntracked files (inspect with fs.read; absent from tracked diff):\n${untracked.stdout}` : "")) };
    }
    return { name, success: true, output: bounded(result.stdout) };
  }

  private async script(args: Record<string, unknown>, signal?: AbortSignal): Promise<AtomicToolResult> {
    if (typeof args.script !== "string" || !["test", "build", "lint", "typecheck"].includes(args.script)) throw new Error("script must be test, build, lint or typecheck.");
    const cwd = await this.path(args.cwd ?? ".");
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd is not a directory.");
    const command = process.platform === "win32" ? "cmd.exe" : "corepack";
    const argv = process.platform === "win32" ? ["/d", "/s", "/c", `corepack pnpm run ${args.script}`] : ["pnpm", "run", args.script];
    const result = await runPackageScript(command, argv, cwd, signal);
    throwIfAborted(signal);
    return { ...result, source: "package_process", script: args.script, command: `corepack pnpm run ${args.script}` };
  }
}

function hash(content: string): string { return createHash("sha256").update(content).digest("hex"); }

/** Wait for process-tree termination before allowing verification or a retry. */
async function runPackageScript(command: string, argv: string[], cwd: string, signal?: AbortSignal): Promise<AtomicToolResult> {
  throwIfAborted(signal);
  return new Promise((resolveResult, reject) => {
    // Runtime supports windowsHide for fork; the repository's older Node type declarations omit it.
    const options: ForkOptions & { windowsHide: boolean } = { windowsHide: true, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] };
    const worker = fork(fileURLToPath(new URL("../../../../scripts/jabberwock-script-worker.mjs", import.meta.url)), [], options);
    let result: AtomicToolResult | undefined;
    const abort = () => { if (worker.connected) worker.send({ type: "cancel" }); };
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", value => { result = { ...(value as Omit<AtomicToolResult, "name">), name: "shell.exec" }; });
    worker.once("error", error => { signal?.removeEventListener("abort", abort); reject(error); });
    worker.once("close", () => {
      signal?.removeEventListener("abort", abort);
      if (result) resolveResult(result); else reject(new Error("Package worker exited before confirming process termination."));
    });
    worker.send({ type: "run", command, argv, cwd });
    if (signal?.aborted) abort();
  });
}

function bounded(value: string, limit = maxOutput): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[output clipped]`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "Atomic tool execution was aborted.");
  error.name = "AbortError";
  throw error;
}
