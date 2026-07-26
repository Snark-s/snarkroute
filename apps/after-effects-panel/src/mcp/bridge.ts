import { useEffect, useState } from "react";

export type BridgeStatus = "connected" | "connecting" | "offline";
export type BridgeDiagnostics = {
  status: BridgeStatus;
  webSocketUrl: string;
  lastError: string | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  lastAttemptAt: string | null;
  reconnectAttempts: number;
};
type SessionInfo = { appVersion: string; projectName: string | null; projectPath: string | null };

export function buildAeBridgeWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl.trim());
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new Error(`Unsupported SnarkRoute server URL protocol: ${url.protocol || "missing"}`);
  url.pathname = "/api/ae-bridge";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function useAeMcpBridge(serverUrl: string, token: string): BridgeDiagnostics {
  const initialUrl = safeWebSocketUrl(serverUrl);
  const [diagnostics, setDiagnostics] = useState<BridgeDiagnostics>(() => emptyDiagnostics(initialUrl.url, initialUrl.error));
  useEffect(() => {
    const resolved = safeWebSocketUrl(serverUrl);
    setDiagnostics(emptyDiagnostics(resolved.url, resolved.error));
    if (!token.trim() || typeof WebSocket === "undefined" || !window.__adobe_cep__ || resolved.error) return;
    let socket: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const sessionId = panelSessionId();

    const log = (event: string, details?: unknown) => {
      if (details === undefined) console.info(`[SnarkRoute AE bridge] ${event}`);
      else console.info(`[SnarkRoute AE bridge] ${event}`, details);
    };
    const scheduleReconnect = () => {
      if (!stopped) retry = setTimeout(() => connect(true), 2_000);
    };

    const sendInfo = async (type: "register" | "heartbeat") => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      try {
        const info = await evalJson<SessionInfo>("SnarkRouteMCP.sessionInfo()");
        socket.send(JSON.stringify({ type, sessionId, host: "aftereffects", extensionVersion: "0.1.0", ...info }));
      } catch { socket.send(JSON.stringify({ type, sessionId, host: "aftereffects", extensionVersion: "0.1.0", appVersion: "unknown", projectName: null, projectPath: null })); }
      log(`${type} sent`);
    };
    const connect = (reconnect = false) => {
      if (stopped) return;
      const attemptedAt = new Date().toISOString();
      setDiagnostics((current) => ({ ...current, status: "connecting", lastError: null, lastAttemptAt: attemptedAt, reconnectAttempts: current.reconnectAttempts + (reconnect ? 1 : 0) }));
      log("bridge connect started", { url: resolved.url, attemptedAt, reconnect });
      try {
        socket = new WebSocket(resolved.url);
        log("WebSocket object created");
      } catch (error) {
        const lastError = errorMessage(error);
        log("error", lastError);
        setDiagnostics((current) => ({ ...current, status: "offline", lastError }));
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        log("open");
        socket?.send(JSON.stringify({ type: "authenticate", token: token.trim() }));
      };
      socket.onmessage = async (event) => {
        try {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === "auth-error" || message.type === "protocol-error") setDiagnostics((current) => ({ ...current, lastError: String(message.message ?? message.type) }));
          if (message.type === "authenticated") { await sendInfo("register"); return; }
          if (message.type === "registered") { setDiagnostics((current) => ({ ...current, status: "connected", lastError: null })); heartbeat = setInterval(() => void sendInfo("heartbeat"), 10_000); return; }
          if (message.type === "execute-jsx") {
            const started = Date.now();
            try {
              const result = await evalJson<Record<string, unknown>>(buildEvalScript(message));
              socket?.send(JSON.stringify({ type: "execute-jsx-result", requestId: message.requestId, durationMs: Date.now() - started, ...result }));
            } catch (error) {
              socket?.send(JSON.stringify({ type: "execute-jsx-result", requestId: message.requestId, ok: false, error: { message: errorMessage(error) }, logs: [], durationMs: Date.now() - started }));
            }
          }
        } catch (error) {
          const lastError = errorMessage(error);
          log("error", lastError);
          setDiagnostics((current) => ({ ...current, lastError }));
        }
      };
      socket.onclose = (event) => {
        log("close", { code: event.code, reason: event.reason });
        if (stopped) return;
        setDiagnostics((current) => ({ ...current, status: "offline", lastCloseCode: event.code, lastCloseReason: event.reason || null }));
        if (heartbeat) clearInterval(heartbeat);
        scheduleReconnect();
      };
      socket.onerror = () => {
        log("error", "WebSocket error");
        if (stopped) return;
        setDiagnostics((current) => ({ ...current, lastError: "WebSocket error" }));
        socket?.close();
      };
    };
    connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); if (heartbeat) clearInterval(heartbeat); socket?.close(); };
  }, [serverUrl, token]);
  return diagnostics;
}

export function buildEvalScript(message: Record<string, unknown>): string { return `SnarkRouteMCP.execute(${JSON.stringify(message)})`; }
export function evalJson<T>(script: string): Promise<T> {
  return new Promise((resolve, reject) => window.__adobe_cep__!.evalScript(script, (raw) => {
    try { const parsed = JSON.parse(raw) as T & { ok?: boolean; error?: { message?: string } }; if (parsed && parsed.ok === false) reject(new Error(parsed.error?.message ?? "After Effects JSX failed.")); else resolve(parsed); }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
  }));
}
function panelSessionId(): string {
  const key = "snarkroute.after-effects.mcp-session-id";
  let value = sessionStorage.getItem(key);
  if (!value) { value = `ae-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; sessionStorage.setItem(key, value); }
  return value;
}

function safeWebSocketUrl(serverUrl: string): { url: string; error: string | null } {
  try { return { url: buildAeBridgeWebSocketUrl(serverUrl), error: null }; }
  catch (error) { return { url: "", error: errorMessage(error) }; }
}
function emptyDiagnostics(webSocketUrl: string, lastError: string | null): BridgeDiagnostics {
  return { status: "offline", webSocketUrl, lastError, lastCloseCode: null, lastCloseReason: null, lastAttemptAt: null, reconnectAttempts: 0 };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
