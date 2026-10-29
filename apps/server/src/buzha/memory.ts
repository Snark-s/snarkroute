import { localServiceHome, localServicePort } from "../services/local-service-endpoints";
import { join } from "node:path";
export function buzhaHome(): string { const home = localServiceHome("buzha"); if (!home) throw new Error("Папка Бужи не зарегистрирована."); return home; }
export async function buzhaMemory(path = "/api/agent/context", body?: unknown): Promise<any> {
  const base = `http://127.0.0.1:${localServicePort("buzha")}`;
  let token: string | undefined;
  if (body) { const session = await fetch(base + "/api/session", { signal: AbortSignal.timeout(5000) }).then(r => r.json()) as { token?: string }; token = session.token; if (!token) throw new Error("Бужа не подтвердила локальную сессию памяти."); }
  const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json", "x-buzha-token": token! } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  const result: any = await response.json(); if (!response.ok) throw new Error(result.error ?? `Бужа: HTTP ${response.status}`); return result;
}
export function buzhaWorkspace(messageId: number): string { if (!Number.isInteger(messageId) || messageId < 1) throw new Error("Некорректное поручение памяти."); return join(buzhaHome(), "data", "agent-work", `message-${messageId}`); }
