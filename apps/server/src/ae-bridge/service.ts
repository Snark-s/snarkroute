import { randomUUID } from "node:crypto";

export type AeSocket = { send(data: string): void; close?(code?: number, reason?: string): void };
export type AeSessionRegistration = {
  type: "register";
  sessionId: string;
  host: "aftereffects";
  appVersion: string;
  extensionVersion: string;
  projectName: string | null;
  projectPath: string | null;
};
export type AeSessionInfo = Omit<AeSessionRegistration, "type"> & { connectedAt: string; lastHeartbeat: string };
export type ExecuteJsxCommand = { code: string; mode?: "execute" | "preview"; timeoutMs?: number; undoGroup?: string | false };
export type ExecuteJsxResult = {
  ok: boolean;
  requestId: string;
  sessionId: string;
  result?: unknown;
  resultType?: string;
  error?: { message: string; stack?: string; line?: number; fileName?: string };
  logs: Array<{ level: "log" | "warn" | "error"; message: string }>;
  durationMs: number;
};

type Session = { info: AeSessionInfo; socket: AeSocket; tail: Promise<void> };
type Pending = { sessionId: string; resolve(value: ExecuteJsxResult): void; reject(error: Error): void; complete(): void; timer: NodeJS.Timeout; startedAt: number; timedOut: boolean };

export class AeBridgeService {
  private readonly sessions = new Map<string, Session>();
  private readonly sockets = new Map<AeSocket, string>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly heartbeatTtlMs = 30_000) {}

  listSessions(): AeSessionInfo[] {
    this.expireStaleSessions();
    return [...this.sessions.values()].map(({ info }) => ({ ...info }));
  }

  handleMessage(socket: AeSocket, raw: string | object): void {
    const message = typeof raw === "string" ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown>;
    if (message.type === "register") {
      this.register(socket, message as unknown as AeSessionRegistration);
      return;
    }
    if (message.type === "heartbeat") {
      const sessionId = this.sockets.get(socket);
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (session) {
        session.info.lastHeartbeat = new Date().toISOString();
        if (typeof message.projectName === "string" || message.projectName === null) session.info.projectName = message.projectName;
        if (typeof message.projectPath === "string" || message.projectPath === null) session.info.projectPath = message.projectPath;
      }
      return;
    }
    if (message.type === "execute-jsx-result") this.finish(message);
  }

  disconnect(socket: AeSocket): void {
    const sessionId = this.sockets.get(socket);
    if (!sessionId) return;
    this.sockets.delete(socket);
    const session = this.sessions.get(sessionId);
    if (session?.socket === socket) this.removeSession(sessionId, "After Effects CEP panel disconnected.");
  }

  expireStaleSessions(now = Date.now()): void {
    for (const [sessionId, session] of this.sessions) {
      if (now - Date.parse(session.info.lastHeartbeat) > this.heartbeatTtlMs) {
        session.socket.close?.(1001, "Heartbeat expired");
        this.removeSession(sessionId, "After Effects session heartbeat expired.");
      }
    }
  }

  resolveSession(sessionId?: string): AeSessionInfo {
    const active = this.listSessions();
    if (sessionId) {
      const match = active.find((session) => session.sessionId === sessionId);
      if (!match) throw new Error(`After Effects session '${sessionId}' is not connected. Open the SnarkRoute CEP panel.`);
      return match;
    }
    if (active.length === 1) return active[0];
    if (active.length === 0) throw new Error("No After Effects session is connected. Open Window > Extensions (Legacy) > SnarkRoute in After Effects.");
    throw new Error(`Multiple After Effects sessions are connected; pass sessionId. Active sessions: ${active.map((item) => `${item.sessionId} (${item.projectName ?? "untitled"})`).join(", ")}`);
  }

  execute(sessionId: string | undefined, command: ExecuteJsxCommand): Promise<ExecuteJsxResult> {
    const selected = this.resolveSession(sessionId);
    const session = this.sessions.get(selected.sessionId)!;
    let resolveResult!: (value: ExecuteJsxResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<ExecuteJsxResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const run = () => {
      try {
        const handles = this.executeNow(session, command);
        handles.result.then(resolveResult, rejectResult);
        return handles.completion;
      } catch (error) {
        rejectResult(error instanceof Error ? error : new Error(String(error)));
        return Promise.resolve();
      }
    };
    session.tail = session.tail.then(run, run).then(() => undefined, () => undefined);
    return result;
  }

  private register(socket: AeSocket, registration: AeSessionRegistration): void {
    if (!registration.sessionId?.trim() || registration.host !== "aftereffects") throw new Error("Invalid After Effects session registration.");
    const previous = this.sessions.get(registration.sessionId);
    if (previous && previous.socket !== socket) this.disconnect(previous.socket);
    const now = new Date().toISOString();
    const info: AeSessionInfo = { sessionId: registration.sessionId, host: "aftereffects", appVersion: registration.appVersion, extensionVersion: registration.extensionVersion, projectName: registration.projectName ?? null, projectPath: registration.projectPath ?? null, connectedAt: now, lastHeartbeat: now };
    this.sessions.set(info.sessionId, { info, socket, tail: Promise.resolve() });
    this.sockets.set(socket, info.sessionId);
    socket.send(JSON.stringify({ type: "registered", sessionId: info.sessionId }));
  }

  private executeNow(session: Session, command: ExecuteJsxCommand): { result: Promise<ExecuteJsxResult>; completion: Promise<void> } {
    const requestId = randomUUID();
    const timeoutMs = Math.min(120_000, Math.max(1_000, command.timeoutMs ?? 30_000));
    if (this.sessions.get(session.info.sessionId) !== session) throw new Error(`After Effects session '${session.info.sessionId}' disconnected before the queued JSX command could start.`);
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    const result = new Promise<ExecuteJsxResult>((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        const entry = this.pending.get(requestId);
        if (entry) entry.timedOut = true;
        resolve({ ok: false, requestId, sessionId: session.info.sessionId, error: { message: `JSX request ${requestId} timed out after ${timeoutMs}ms. Waiting stopped, but ExtendScript may still be running in After Effects.` }, logs: [], durationMs: Date.now() - startedAt });
      }, timeoutMs);
      this.pending.set(requestId, { sessionId: session.info.sessionId, resolve, reject, complete, timer, startedAt, timedOut: false });
      try {
        session.socket.send(JSON.stringify({ type: "execute-jsx", requestId, code: command.code, mode: command.mode ?? "execute", timeoutMs, undoGroup: command.undoGroup ?? "MCP: arbitrary JSX" }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        complete();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { result, completion };
  }

  private finish(message: Record<string, unknown>): void {
    const requestId = String(message.requestId ?? "");
    const entry = this.pending.get(requestId);
    if (!entry) return; // A late result after timeout is deliberately ignored.
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    const durationMs = typeof message.durationMs === "number" ? message.durationMs : Date.now() - entry.startedAt;
    if (!entry.timedOut) entry.resolve({ ok: message.ok === true, requestId, sessionId: entry.sessionId, result: message.result, resultType: typeof message.resultType === "string" ? message.resultType : undefined, error: message.error as ExecuteJsxResult["error"], logs: Array.isArray(message.logs) ? message.logs as ExecuteJsxResult["logs"] : [], durationMs });
    entry.complete();
  }

  private removeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.sockets.delete(session.socket);
    for (const [requestId, entry] of this.pending) if (entry.sessionId === sessionId) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      if (!entry.timedOut) entry.reject(new Error(reason));
      entry.complete();
    }
  }
}

export const aeBridgeService = new AeBridgeService();
