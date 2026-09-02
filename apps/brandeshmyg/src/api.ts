import type { CanvasNodeAction, ToolInputState, ToolResult, ToolTabState } from "@snarkroute/canvas-action-host";

export const apiBase = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:4317";

export interface SessionRunResponse {
  status: "paused" | "completed";
  continuationId?: string;
  previews?: Array<{ kind: "panorama360" | "splat"; src: string }>;
  results: ToolResult[];
}

export async function loadActions(): Promise<CanvasNodeAction[]> {
  return (await api<{ actions: CanvasNodeAction[] }>("/api/nodes/canvas-actions?surface=brandeshmyg")).actions;
}

export async function runSession(input: { sessionId: string; actionId: string; toolInputs: Record<string, ToolInputState>; params: Record<string, unknown>; phase?: "prepare" | "complete"; continuationId?: string }): Promise<SessionRunResponse> {
  const bodyInputs = await serializeToolInputs(input.toolInputs);
  const response = await api<SessionRunResponse>(`/api/canvas-action-sessions/${encodeURIComponent(input.sessionId)}/actions/${encodeURIComponent(input.actionId)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: bodyInputs, params: input.params, phase: input.phase, continuationId: input.continuationId })
  });
  return resolveSessionMediaUrls(response);
}

export async function serializeToolInputs(inputs: Record<string, ToolInputState>): Promise<Record<string, { type: "text"; text: string } | { type: "image" | "video" | "audio"; filename: string; mimeType: string; dataBase64: string }>> {
  const entries = await Promise.all(Object.entries(inputs).map(async ([id, input]) => {
    if (input.kind === "empty") throw new Error(`Select ${id} first.`);
    return [id, input.kind === "text"
      ? { type: "text" as const, text: input.text }
      : { type: input.type, filename: input.file.name, mimeType: input.file.type, dataBase64: await fileBase64(input.file) }] as const;
  }));
  return Object.fromEntries(entries);
}

export function resolveSessionMediaUrls(response: SessionRunResponse, base = apiBase): SessionRunResponse {
  const previews = response.previews?.map((preview) => ({ ...preview, src: resolveApiMediaUrl(preview.src, base) }));
  return {
    ...response,
    ...(previews ? { previews } : {}),
    results: response.results.map((result) => result.url ? { ...result, url: resolveApiMediaUrl(result.url, base) } : result)
  };
}

export function resolveToolTabMediaUrls(tab: ToolTabState, base = apiBase): ToolTabState {
  const media = resolveSessionMediaUrls({
    status: tab.status === "paused" ? "paused" : "completed",
    previews: tab.preparedPreviews,
    results: tab.results
  }, base);
  return { ...tab, preparedPreviews: media.previews, results: media.results };
}

export function resolveApiMediaUrl(url: string, base = apiBase): string {
  if (!/^\/api(?:\/|\?|$)/i.test(url)) return url;
  return `${base.replace(/\/+$/, "")}${url}`;
}

export async function disposeSession(sessionId: string): Promise<void> {
  await api(`/api/canvas-action-sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

export async function previewPackage(file: File): Promise<Record<string, unknown>> {
  return api("/api/node-packages/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await packageBody(file)) });
}

export async function installPackage(file: File): Promise<void> {
  await api("/api/node-packages/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await packageBody(file)) });
}

async function packageBody(file: File) {
  return file.name.toLowerCase().endsWith(".json")
    ? { filename: file.name, text: await file.text(), source: file.name }
    : { filename: file.name, dataBase64: await fileBase64(file), source: file.name };
}

async function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; issues?: Array<{ path: string; message: string }> };
    throw new Error(body.error ?? body.issues?.map((issue) => `${issue.path}: ${issue.message}`).join("\n") ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
