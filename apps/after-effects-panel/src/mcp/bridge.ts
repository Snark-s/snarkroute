import { useEffect, useState } from "react";

export type BridgeStatus = "pairing" | "connecting" | "connected" | "disconnected";
export type McpServerStatus = "checking" | "reachable" | "unavailable";
export type PairingStatus = "idle" | "requesting" | "paired" | "unavailable";
export type AeSessionStatus = "registered" | "not_registered";
export type BridgeDiagnostics = {
  mcpServerStatus: McpServerStatus;
  bridgeStatus: BridgeStatus;
  pairingStatus: PairingStatus;
  sessionStatus: AeSessionStatus;
  mcpUrl: string;
  webSocketUrl: string;
  sessionId: string;
  lastError: string | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  lastAttemptAt: string | null;
  lastConnectedAt: string | null;
  reconnectAttempts: number;
  connectionPrerequisite: string;
};
type SessionInfo = { appVersion: string; projectName: string | null; projectPath: string | null };
type PairingResponse = { pairingToken: string; expiresInMs: number };

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

export function useAeMcpBridge(serverUrl: string, manualToken = ""): BridgeDiagnostics {
  const initialUrl = safeWebSocketUrl(serverUrl);
  const [diagnostics, setDiagnostics] = useState<BridgeDiagnostics>(() => emptyDiagnostics(serverUrl, initialUrl.url, initialUrl.error));
  useEffect(() => {
    const resolved = safeWebSocketUrl(serverUrl);
    const initial = emptyDiagnostics(serverUrl, resolved.url, resolved.error);
    setDiagnostics(initial);
    if (resolved.error) return;
    if (typeof WebSocket === "undefined") { setDiagnostics((current) => ({ ...current, connectionPrerequisite: "WebSocket API unavailable" })); return; }
    if (!window.__adobe_cep__) { setDiagnostics((current) => ({ ...current, connectionPrerequisite: "Adobe CEP host unavailable" })); return; }
    let socket: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const sessionId = panelSessionId();
    let consecutiveRetries = 0;
    setDiagnostics((current) => ({ ...current, sessionId, connectionPrerequisite: "ready" }));

    const log = (event: string, details?: unknown) => {
      if (details === undefined) console.info(`[SnarkRoute AE bridge] ${event}`);
      else console.info(`[SnarkRoute AE bridge] ${event}`, details);
    };
    const scheduleReconnect = () => {
      if (stopped || retry) return;
      const delay = Math.min(10_000, 1_000 * Math.pow(2, Math.min(consecutiveRetries, 3)));
      consecutiveRetries++;
      setDiagnostics((current) => ({ ...current, reconnectAttempts: current.reconnectAttempts + 1 }));
      retry = setTimeout(() => { retry = undefined; void connect(true); }, delay);
    };

    const sendInfo = async (type: "register" | "heartbeat") => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      try {
        const info = await evalJson<SessionInfo>("SnarkRouteMCP.sessionInfo()");
        socket.send(JSON.stringify({ type, sessionId, host: "aftereffects", extensionVersion: "0.1.0", ...info }));
      } catch { socket.send(JSON.stringify({ type, sessionId, host: "aftereffects", extensionVersion: "0.1.0", appVersion: "unknown", projectName: null, projectPath: null })); }
      log(`${type} sent`);
    };
    const connect = async (reconnect = false) => {
      if (stopped) return;
      const attemptedAt = new Date().toISOString();
      setDiagnostics((current) => ({ ...current, mcpServerStatus: "checking", bridgeStatus: "pairing", pairingStatus: "requesting", sessionStatus: "not_registered", lastError: null, lastAttemptAt: attemptedAt, connectionPrerequisite: reconnect ? "retrying local server" : "checking local server" }));
      log("bridge initialization", { attemptedAt, reconnect });
      try {
        const health = await fetch(endpoint(serverUrl, "/health"), { method: "GET", cache: "no-store", credentials: "omit" });
        if (!health.ok) throw new Error(`MCP server health check failed with HTTP ${health.status}.`);
        if (stopped) return;
        setDiagnostics((current) => ({ ...current, mcpServerStatus: "reachable", connectionPrerequisite: "requesting local pairing" }));
        const pair = await fetch(endpoint(serverUrl, "/api/ae-bridge/pair"), { method: "POST", cache: "no-store", credentials: "omit" });
        let pairingToken = "", useManualToken = false;
        if (pair.ok) {
          const payload = await pair.json() as PairingResponse;
          if (!payload.pairingToken) throw new Error("Pairing response did not include a credential.");
          pairingToken = payload.pairingToken;
        } else if (manualToken.trim()) useManualToken = true;
        else {
          setDiagnostics((current) => ({ ...current, bridgeStatus: "disconnected", pairingStatus: "unavailable", connectionPrerequisite: `pairing unavailable (HTTP ${pair.status})` }));
          scheduleReconnect();
          return;
        }
        if (stopped) return;
        const connectUrl = new URL(resolved.url);
        if (pairingToken) connectUrl.searchParams.set("pairingToken", pairingToken);
        setDiagnostics((current) => ({ ...current, bridgeStatus: "connecting", pairingStatus: pairingToken ? "paired" : "unavailable", connectionPrerequisite: "opening WebSocket" }));
        socket = new WebSocket(connectUrl.toString());
        log("WebSocket object created");
        socket.onopen = () => { log("open"); if (useManualToken) socket?.send(JSON.stringify({ type: "authenticate", token: manualToken.trim() })); };
        socket.onmessage = async (event) => {
          try {
            const message = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (message.type === "auth-error" || message.type === "protocol-error") setDiagnostics((current) => ({ ...current, lastError: String(message.message ?? message.type) }));
            if (message.type === "authenticated") { await sendInfo("register"); return; }
            if (message.type === "registered") { consecutiveRetries = 0; const lastConnectedAt = new Date().toISOString(); setDiagnostics((current) => ({ ...current, bridgeStatus: "connected", sessionStatus: "registered", lastError: null, lastConnectedAt, connectionPrerequisite: "ready" })); heartbeat = setInterval(() => void sendInfo("heartbeat"), 10_000); return; }
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
          setDiagnostics((current) => ({ ...current, bridgeStatus: "disconnected", sessionStatus: "not_registered", lastCloseCode: event.code, lastCloseReason: event.reason || null, connectionPrerequisite: "WebSocket closed" }));
          if (heartbeat) clearInterval(heartbeat);
          scheduleReconnect();
        };
        socket.onerror = () => {
          log("error", "WebSocket error");
          if (stopped) return;
          setDiagnostics((current) => ({ ...current, lastError: "WebSocket error" }));
          socket?.close();
        };
      } catch (error) {
        const lastError = errorMessage(error);
        log("connection prerequisites failed", lastError);
        setDiagnostics((current) => ({ ...current, mcpServerStatus: "unavailable", bridgeStatus: "disconnected", pairingStatus: "idle", sessionStatus: "not_registered", lastError, connectionPrerequisite: lastError }));
        scheduleReconnect();
      }
    };
    void connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); if (heartbeat) clearInterval(heartbeat); socket?.close(); };
  }, [serverUrl, manualToken]);
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
function endpoint(serverUrl: string, path: string): string { const url = new URL(serverUrl.trim()); url.pathname = path; url.search = ""; url.hash = ""; return url.toString(); }
function emptyDiagnostics(serverUrl: string, webSocketUrl: string, lastError: string | null): BridgeDiagnostics {
  let mcpUrl = ""; try { mcpUrl = endpoint(serverUrl, "/mcp"); } catch {}
  return { mcpServerStatus: "checking", bridgeStatus: "disconnected", pairingStatus: "idle", sessionStatus: "not_registered", mcpUrl, webSocketUrl, sessionId: "", lastError, lastCloseCode: null, lastCloseReason: null, lastAttemptAt: null, lastConnectedAt: null, reconnectAttempts: 0, connectionPrerequisite: lastError ?? "initializing" };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
