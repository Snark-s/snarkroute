import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Who is on the other end of a local TCP connection, by process, not by headers. Used for model
 * and GPU requests that carry no token: a caller inside an agent's process tree (an agent app,
 * a delegated executor, a PersonaCore run, a Codex/Claude CLI) is treated as that agent, so leaving
 * the token out does not get around the dispatcher. Browsers, Adobe panels and Mixar stay
 * interactive clients of the owner: they may run models, they never manage agents.
 */

const execFileAsync = promisify(execFile);

export type ProcessRow = { pid: number; ppid: number; name: string };
export type Attribution =
  | { kind: "agent"; agentId: string; via: string }
  | { kind: "interactive"; client: string; pid: number }
  | { kind: "unknown"; reason: string };

/** AI agent hosts: anything they start is agent work, with or without a SnarkRoute token. */
export const AGENT_HOST_NAMES = ["codex", "claude", "codex-code-mode-host"];

/** The owner's interactive programs: a request from them (or from inside them, like an Adobe panel) is interactive. */
export const INTERACTIVE_APP_NAMES = ["chrome", "msedge", "firefox", "browser", "photoshop", "afterfx", "cephtmlengine", "uxp", "premiere pro",
  "mixar", "blender", "unrealeditor", "touchdesigner", "explorer"];

/** Where a complete ancestry ends: the desktop session, not a vanished parent. */
const SESSION_ROOT_NAMES = ["explorer", "sihost", "services", "wininit", "svchost", "system", "smss"];

export type CallerDeps = {
  connections?: () => Promise<Array<{ localPort: number; remotePort: number; pid: number }>>;
  processes?: () => Promise<ProcessRow[]>;
  /** pid → agent id of processes SnarkRoute started for agents (apps, executors, PersonaCore runs). */
  agentRoots: () => Map<number, string>;
  now?: () => number;
};

export class CallerAttribution {
  private connectionCache?: { at: number; rows: Array<{ localPort: number; remotePort: number; pid: number }> };
  private processCache?: { at: number; rows: Map<number, ProcessRow> };
  private recent: Array<{ at: string; path: string; attribution: Attribution }> = [];

  constructor(private readonly deps: CallerDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** `clientPort` is the caller's ephemeral port, `serverPort` the SnarkRoute port it connected to. */
  async attribute(clientPort: number, serverPort: number): Promise<Attribution> {
    const pid = await this.ownerPid(clientPort, serverPort);
    if (!pid) return { kind: "unknown", reason: "процесс клиента не найден" };
    const table = await this.processTable(false);
    let current = table.get(pid) ?? (await this.processTable(true)).get(pid);
    if (!current) return { kind: "unknown", reason: `процесс ${pid} не найден` };
    const roots = this.deps.agentRoots();
    const first = current;
    let interactiveApp: string | undefined;
    let complete = false;
    for (let depth = 0; current && depth < 40; depth += 1) {
      const root = roots.get(current.pid);
      if (root) return { kind: "agent", agentId: root, via: `${first.name} (pid ${first.pid}) в дереве ${root}` };
      if (AGENT_HOST_NAMES.includes(current.name)) return { kind: "agent", agentId: `host:${current.name}`, via: `${first.name} (pid ${first.pid}) запущен из ${current.name}` };
      if (!interactiveApp && INTERACTIVE_APP_NAMES.includes(current.name)) interactiveApp = current.name;
      if (SESSION_ROOT_NAMES.includes(current.name) || current.ppid === 0) { complete = true; break; }
      if (current.ppid === current.pid) break;
      current = table.get(current.ppid);
    }
    // A vanished parent hides who started the caller: without an interactive program in what remains, it is not trusted as the owner.
    if (complete || interactiveApp) return { kind: "interactive", client: interactiveApp && interactiveApp !== "explorer" ? interactiveApp : first.name, pid: first.pid };
    return { kind: "unknown", reason: `цепочка процессов ${first.name} (pid ${first.pid}) обрывается: запускавший процесс уже завершён` };
  }

  note(path: string, attribution: Attribution): void {
    this.recent = [...this.recent, { at: new Date(this.now()).toISOString(), path, attribution }].slice(-30);
  }

  recentCalls() { return [...this.recent]; }

  private async ownerPid(clientPort: number, serverPort: number): Promise<number | undefined> {
    const find = (rows: Array<{ localPort: number; remotePort: number; pid: number }>) => rows.find(row => row.localPort === clientPort && row.remotePort === serverPort)?.pid;
    if (this.connectionCache && this.now() - this.connectionCache.at < 2000) {
      const cached = find(this.connectionCache.rows);
      if (cached) return cached;
    }
    const rows = await (this.deps.connections ?? listTcpConnections)().catch(() => []);
    this.connectionCache = { at: this.now(), rows };
    return find(rows);
  }

  private async processTable(force: boolean): Promise<Map<number, ProcessRow>> {
    if (!force && this.processCache && this.now() - this.processCache.at < 15_000) return this.processCache.rows;
    const rows = await (this.deps.processes ?? listProcesses)().catch(() => [] as ProcessRow[]);
    this.processCache = { at: this.now(), rows: new Map(rows.map(row => [row.pid, row])) };
    return this.processCache.rows;
  }
}

/** Windows `netstat -ano`: client-side rows of loopback TCP connections. */
export async function listTcpConnections(): Promise<Array<{ localPort: number; remotePort: number; pid: number }>> {
  if (process.platform !== "win32") return [];
  const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]):(\d+)\s+(?:127\.0\.0\.1|\[::1\]):(\d+)\s+\S+\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ localPort: Number(match[1]), remotePort: Number(match[2]), pid: Number(match[3]) });
  }
  return rows;
}

export async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform !== "win32") return [];
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
  const parsed = JSON.parse(stdout || "[]") as Array<{ ProcessId: number; ParentProcessId: number; Name: string }>;
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, name: String(row.Name ?? "").toLowerCase().replace(/\.exe$/, "") }));
}

/** Requests that start model or GPU work; only these are attributed (management needs a credential anyway). */
export function isModelWorkRequest(method: string, url: string): boolean {
  if (method !== "POST") return false;
  const path = url.split("?")[0];
  return /^\/api\/(routes\/run|model-gateway\/jobs|execution|tool-jobs|system\/buzha\/chat\/completions|system\/local-runtimes\/[^/]+\/start)/.test(path);
}
