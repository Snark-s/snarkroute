export function replicateTokenStatusText(configured: boolean): string {
  return `Replicate token: ${configured ? "configured" : "missing"}`;
}

export function localApiUnavailableMessage(apiBaseUrl: string): string {
  return `Local API server is not reachable at ${apiBaseUrl}. Run start-snarkroute.bat or start the server manually. Check VITE_API_BASE_URL if needed.`;
}

export function serializeRouteJson(route: unknown): string {
  return JSON.stringify(route, null, 2);
}
