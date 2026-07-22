import { useEffect, useState } from "react";

type BridgeStatus = "connected" | "connecting" | "offline";
type SessionInfo = { appVersion: string; projectName: string | null; projectPath: string | null };

export function useAeMcpBridge(serverUrl: string, token: string): BridgeStatus {
  const [status, setStatus] = useState<BridgeStatus>("offline");
  useEffect(() => {
    if (!token.trim() || typeof WebSocket === "undefined" || !window.__adobe_cep__) { setStatus("offline"); return; }
    let socket: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const sessionId = panelSessionId();

    const sendInfo = async (type: "register" | "heartbeat") => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      try {
        const info = await evalJson<SessionInfo>("SnarkRouteMCP.sessionInfo()");
        socket.send(JSON.stringify({ type, sessionId, host: "aftereffects", extensionVersion: "0.1.0", ...info }));
      } catch { socket.send(JSON.stringify({ type, sessionId, host: "aftereffects", extensionVersion: "0.1.0", appVersion: "unknown", projectName: null, projectPath: null })); }
    };
    const connect = () => {
      if (stopped) return;
      setStatus("connecting");
      const wsUrl = `${serverUrl.replace(/\/$/, "").replace(/^http/i, "ws")}/api/ae-bridge`;
      socket = new WebSocket(wsUrl);
      socket.onopen = () => socket?.send(JSON.stringify({ type: "authenticate", token }));
      socket.onmessage = async (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "authenticated") { await sendInfo("register"); return; }
        if (message.type === "registered") { setStatus("connected"); heartbeat = setInterval(() => void sendInfo("heartbeat"), 10_000); return; }
        if (message.type === "execute-jsx") {
          const started = Date.now();
          try {
            const result = await evalJson<Record<string, unknown>>(buildEvalScript(message));
            socket?.send(JSON.stringify({ type: "execute-jsx-result", requestId: message.requestId, durationMs: Date.now() - started, ...result }));
          } catch (error) {
            socket?.send(JSON.stringify({ type: "execute-jsx-result", requestId: message.requestId, ok: false, error: { message: error instanceof Error ? error.message : String(error) }, logs: [], durationMs: Date.now() - started }));
          }
        }
      };
      socket.onclose = () => { setStatus("offline"); if (heartbeat) clearInterval(heartbeat); if (!stopped) retry = setTimeout(connect, 2_000); };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); if (heartbeat) clearInterval(heartbeat); socket?.close(); };
  }, [serverUrl, token]);
  return status;
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
