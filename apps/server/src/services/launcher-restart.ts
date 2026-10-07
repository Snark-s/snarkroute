export async function launcherControlRequest(path: "status" | "restart", method: "GET" | "POST" = "GET") {
  const port = Number(process.env.SNARKROUTE_LAUNCHER_CONTROL_PORT ?? 5176);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid launcher control port");
  const response = await fetch(`http://127.0.0.1:${port}/${path}`, { method, signal: AbortSignal.timeout(3000),
    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}) });
  const result = await response.json() as { ok?: boolean; error?: string; service?: string; apiPort?: number; managed?: boolean; serverPid?: number; operation?: { state?: string; action?: string } };
  if (!response.ok || !result.ok) throw new Error(result.error ?? "Launcher control is unavailable");
  if (result.service !== "snarkroute-launcher-control" || result.apiPort !== Number(process.env.API_PORT ?? 4317)) throw new Error("Launcher owns a different server");
  return result;
}
