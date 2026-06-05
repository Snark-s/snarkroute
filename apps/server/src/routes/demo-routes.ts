import type { OpenRoute } from "@snarkroute/protocol";

const DEMO_SAFE_ROUTE_IDS = new Set(["boojum-cloud-polza-image-demo", "boojum-cloud-polza-video-demo"]);
const GUEST_BLOCKED_NODE_TYPES = new Set(["output.file", "input.file"]);

export function isDemoSafeRoute(route: OpenRoute): boolean {
  if (DEMO_SAFE_ROUTE_IDS.has(route.route.id)) return true;
  if (route.route.tags?.includes("demo-safe")) return true;
  const provenance = route.provenance;
  if (provenance && typeof provenance === "object" && "demoSafe" in provenance && provenance.demoSafe === true) return true;
  return false;
}

export function validateGuestDemoRoute(route: OpenRoute): void {
  if (!isDemoSafeRoute(route)) throw new Error("Guest demo can only run demo-safe examples.");
  for (const node of route.nodes) {
    if (GUEST_BLOCKED_NODE_TYPES.has(node.type)) throw new Error("Guest demo cannot use local file nodes.");
    if (node.params?.credentialMode === "user-session") throw new Error("Guest demo cannot use user credentials.");
  }
}
