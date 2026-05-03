export function replicateTokenStatusText(configured: boolean): string {
  return `Replicate token: ${configured ? "configured" : "missing"}`;
}

export function serializeRouteJson(route: unknown): string {
  return JSON.stringify(route, null, 2);
}
