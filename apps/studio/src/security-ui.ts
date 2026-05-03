export function replicateTokenStatusText(configured: boolean): string {
  return `Replicate token: ${configured ? "configured" : "missing"}`;
}

export function localApiUnavailableMessage(apiBaseUrl: string): string {
  return `Local API server is not reachable at ${apiBaseUrl}. Start the server or check VITE_API_BASE_URL.`;
}

export function serializeRouteJson(route: unknown): string {
  return JSON.stringify(route, null, 2);
}
