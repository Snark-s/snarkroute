import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

type JsonRecord = Record<string, unknown>;
type CodexTransferStage = "connect" | "thread-start" | "turn-start" | "confirm" | "desktop-open";

export type CodexDesktopTransferInput = {
  taskId: string;
  workspace: string;
  prompt: string;
  handoffPath: string;
  existingThreadId?: string;
};

export type CodexDesktopTransferResult = {
  confirmed: true;
  threadId: string;
  turnId?: string;
  desktopTarget: string;
};

export class CodexDesktopTransferError extends Error {
  constructor(
    message: string,
    readonly stage: CodexTransferStage,
    readonly threadId?: string,
    readonly taskCreated = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CodexDesktopTransferError";
  }
}

export type CodexRpcSession = {
  request(method: string, params: JsonRecord): Promise<JsonRecord>;
  retainUntilTurnCompletes(threadId: string, turnId: string): void;
  close(): Promise<void>;
};

type CodexDesktopDependencies = {
  connect: (workspace: string) => Promise<CodexRpcSession>;
  openThread: (threadId: string) => Promise<string>;
  delay: (milliseconds: number) => Promise<void>;
  log: Pick<Console, "info" | "warn" | "error">;
};

const defaultDependencies: CodexDesktopDependencies = {
  connect: connectCodexAppServer,
  openThread: openCodexDesktopThread,
  delay: (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  log: console
};

export async function transferToCodexDesktop(
  input: CodexDesktopTransferInput,
  overrides: Partial<CodexDesktopDependencies> = {}
): Promise<CodexDesktopTransferResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const logContext = { taskId: input.taskId, workspace: input.workspace, handoffPath: input.handoffPath };

  if (input.existingThreadId) {
    dependencies.log.info("[codex-handoff] retrying Desktop navigation", { ...logContext, threadId: input.existingThreadId });
    try {
      const desktopTarget = await dependencies.openThread(input.existingThreadId);
      return { confirmed: true, threadId: input.existingThreadId, desktopTarget };
    } catch (error) {
      throw new CodexDesktopTransferError(
        `Codex task ${input.existingThreadId} exists, but Codex Desktop could not open it: ${message(error)}`,
        "desktop-open",
        input.existingThreadId,
        true,
        { cause: error }
      );
    }
  }

  dependencies.log.info("[codex-handoff] connecting to Codex app-server", {
    ...logContext,
    promptCharacters: input.prompt.length
  });
  let session: CodexRpcSession;
  try {
    session = await dependencies.connect(input.workspace);
  } catch (error) {
    throw new CodexDesktopTransferError(`Codex app-server could not be started: ${message(error)}`, "connect", undefined, false, { cause: error });
  }

  let threadId: string | undefined;
  let turnId: string | undefined;
  let retainSession = false;
  try {
    let started: JsonRecord;
    try {
      started = await session.request("thread/start", { cwd: input.workspace, serviceName: "snarkroute-jabberwock" });
      threadId = nestedString(started, "thread", "id");
      if (!threadId) throw new Error("thread/start returned no thread.id");
      dependencies.log.info("[codex-handoff] Codex thread allocated", { ...logContext, threadId });
    } catch (error) {
      throw new CodexDesktopTransferError(`Codex did not create a thread: ${message(error)}`, "thread-start", threadId, false, { cause: error });
    }

    try {
      const turn = await session.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt }]
      });
      turnId = nestedString(turn, "turn", "id");
      if (!turnId) throw new Error("turn/start returned no turn.id");
      session.retainUntilTurnCompletes(threadId, turnId);
      retainSession = true;
      dependencies.log.info("[codex-handoff] context accepted by Codex", { ...logContext, threadId, turnId });
    } catch (error) {
      throw new CodexDesktopTransferError(`Codex did not accept the prepared context: ${message(error)}`, "turn-start", threadId, false, { cause: error });
    }

    try {
      await confirmThread(session, threadId, turnId, dependencies.delay);
      dependencies.log.info("[codex-handoff] Codex task creation confirmed by read-back", { ...logContext, threadId, turnId });
    } catch (error) {
      throw new CodexDesktopTransferError(
        `Codex accepted the request but did not confirm the new task: ${message(error)}`,
        "confirm",
        threadId,
        false,
        { cause: error }
      );
    }

    try {
      const desktopTarget = await dependencies.openThread(threadId);
      dependencies.log.info("[codex-handoff] Codex Desktop navigation accepted", { ...logContext, threadId, turnId, desktopTarget });
      return { confirmed: true, threadId, turnId, desktopTarget };
    } catch (error) {
      throw new CodexDesktopTransferError(
        `Codex task ${threadId} was created and confirmed, but Codex Desktop could not open it: ${message(error)}`,
        "desktop-open",
        threadId,
        true,
        { cause: error }
      );
    }
  } finally {
    if (!retainSession) await session.close().catch(() => undefined);
  }
}

async function confirmThread(
  session: CodexRpcSession,
  threadId: string,
  turnId: string,
  delay: (milliseconds: number) => Promise<void>
): Promise<void> {
  let lastProblem = "thread/read did not return the created turn";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt) await delay(250);
    try {
      const readBack = await session.request("thread/read", { threadId, includeTurns: true });
      const confirmedThreadId = nestedString(readBack, "thread", "id");
      const turns = nestedArray(readBack, "thread", "turns");
      if (confirmedThreadId === threadId && turns.some((turn) => isRecord(turn) && turn.id === turnId)) return;
      lastProblem = `thread/read returned thread ${confirmedThreadId ?? "<missing>"} without turn ${turnId}`;
    } catch (error) {
      lastProblem = message(error);
    }
  }
  throw new Error(lastProblem);
}

async function connectCodexAppServer(workspace: string): Promise<CodexRpcSession> {
  const command = await findCodexCliExecutable();
  const child = spawn(command, ["app-server", "--stdio"], {
    cwd: workspace,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const session = new ProcessCodexRpcSession(child, command);
  try {
    await session.request("initialize", {
      clientInfo: { name: "snarkroute-jabberwock", title: "SnarkRoute Jabberwock", version: "0.1.0" }
    });
    session.notify("initialized", {});
    return session;
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}

class ProcessCodexRpcSession implements CodexRpcSession {
  private nextId = 0;
  private readonly pending = new Map<number, { method: string; resolve(value: JsonRecord): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly notificationListeners = new Set<(message: JsonRecord) => void>();
  private readonly stderr: string[] = [];
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly command: string) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr.push(chunk);
      while (this.stderr.join("").length > 12_000) this.stderr.shift();
    });
    child.once("error", (error) => this.failAll(new Error(`Could not run ${command}: ${message(error)}`)));
    child.once("exit", (code, signal) => {
      if (!this.closed) this.failAll(new Error(`Codex app-server exited before confirmation (code ${code ?? "?"}, signal ${signal ?? "none"}). ${this.stderrText()}`.trim()));
    });
  }

  request(method: string, params: JsonRecord): Promise<JsonRecord> {
    if (this.closed) return Promise.reject(new Error("Codex app-server connection is closed."));
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after 15 seconds. ${this.stderrText()}`.trim()));
      }, 15_000);
      this.pending.set(id, { method, resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Could not send ${method} to Codex app-server: ${message(error)}`));
      });
    });
  }

  notify(method: string, params: JsonRecord): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  retainUntilTurnCompletes(threadId: string, turnId: string): void {
    const release = (notification: JsonRecord) => {
      if (notification.method !== "turn/completed") return;
      const notificationThreadId = nestedString(notification, "params", "threadId");
      const notificationTurnId = nestedString(notification, "params", "turn", "id") ?? nestedString(notification, "params", "turnId");
      if (notificationThreadId !== threadId || notificationTurnId !== turnId) return;
      this.notificationListeners.delete(release);
      void this.close();
    };
    this.notificationListeners.add(release);
    const maximumLifetime = setTimeout(() => void this.close(), 12 * 60 * 60 * 1_000);
    maximumLifetime.unref();
    this.child.once("exit", () => clearTimeout(maximumLifetime));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.failAll(new Error("Codex app-server connection closed."));
    const exited = new Promise<void>((resolvePromise) => this.child.once("exit", () => resolvePromise()));
    const timeout = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 750));
    await Promise.race([exited, timeout]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    this.child.unref();
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let response: JsonRecord;
    try {
      response = JSON.parse(line) as JsonRecord;
    } catch {
      return;
    }
    if (typeof response.id === "number") {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (isRecord(response.error)) {
        pending.reject(new Error(`${pending.method} failed: ${String(response.error.message ?? "unknown JSON-RPC error")}`));
      } else if (isRecord(response.result)) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(`${pending.method} returned an invalid JSON-RPC response.`));
      }
      return;
    }
    for (const listener of this.notificationListeners) listener(response);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stderrText(): string {
    return this.stderr.join("").trim().split(/\r?\n/).slice(-4).join(" | ");
  }
}

export function codexThreadLaunchSpec(
  threadId: string,
  desktopExecutable?: string,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[]; target: string } {
  const target = `codex://threads/${encodeURIComponent(threadId)}`;
  if (platform === "win32") {
    if (!desktopExecutable || !existsSync(desktopExecutable)) {
      throw new Error("The current Codex Desktop executable was not found. Reinstall or update Codex Desktop.");
    }
    // Packaged apps must be activated through the Windows URI handler. Starting
    // Codex.exe directly bypasses that activation context, while explorer.exe
    // reports exit code 1 after successfully delegating to an existing app.
    // Start-Process uses ShellExecute and returns a meaningful failure if the
    // registered handler cannot accept the URI.
    const quotedTarget = target.replaceAll("'", "''");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${quotedTarget}' -ErrorAction Stop`],
      target
    };
  }
  if (platform === "darwin") return { command: "open", args: [target], target };
  return { command: "xdg-open", args: [target], target };
}

async function openCodexDesktopThread(threadId: string): Promise<string> {
  const desktopExecutable = await findCodexDesktopExecutable();
  if (process.platform === "win32" && desktopExecutable) await repairWindowsCodexProtocol(desktopExecutable);
  const spec = codexThreadLaunchSpec(threadId, desktopExecutable);
  await launchAndConfirm(spec.command, spec.args);
  return spec.target;
}

async function findCodexCliExecutable(): Promise<string> {
  const configured = process.env.CODEX_CLI_EXECUTABLE?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error(`CODEX_CLI_EXECUTABLE does not exist: ${configured}`);
    return configured;
  }
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const output = await execText(finder, ["codex"]).catch(() => "");
  const candidates = output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const executable = candidates.find((candidate) => process.platform !== "win32" || candidate.toLowerCase().endsWith(".exe")) ?? candidates[0];
  if (!executable) throw new Error("Codex CLI was not found on PATH. Install or update Codex Desktop, or set CODEX_CLI_EXECUTABLE.");
  return executable;
}

async function findCodexDesktopExecutable(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const configured = process.env.CODEX_DESKTOP_EXECUTABLE?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error(`CODEX_DESKTOP_EXECUTABLE does not exist: ${configured}`);
    return configured;
  }
  const packageRoot = (await execText("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "(Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation)"
  ])).trim();
  const executable = packageRoot ? join(packageRoot, "app", "Codex.exe") : "";
  if (executable && existsSync(executable)) return executable;
  throw new Error("The current Codex Desktop executable was not found. Reinstall or update Codex Desktop.");
}

async function repairWindowsCodexProtocol(desktopExecutable: string): Promise<void> {
  const commandKey = "HKCU\\Software\\Classes\\codex\\shell\\open\\command";
  const commandValue = `"${desktopExecutable}" "%1"`;
  await execText("reg.exe", ["add", commandKey, "/ve", "/d", commandValue, "/f"]);
}

function launchAndConfirm(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${basename(command)} did not confirm URI activation within 10 seconds.`)), 10_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        child.unref();
        resolvePromise();
      }
    };
    child.once("error", (error) => finish(new Error(`Could not start ${basename(command)}: ${message(error)}`)));
    child.once("exit", (code) => code === 0 ? finish() : finish(new Error(`${basename(command)} exited with code ${code ?? "unknown"}.`)));
  });
}

function execText(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
      resolvePromise(stdout);
    });
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nestedString(value: unknown, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function nestedArray(value: unknown, ...path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
