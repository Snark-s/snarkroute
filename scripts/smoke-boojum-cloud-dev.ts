const API_URL = process.env.BOOJUM_API_URL ?? "http://127.0.0.1:4317";

type CookieJar = Record<string, string>;

async function main() {
  const guestJar: CookieJar = {};
  const capabilities = await api<{ product: string; mode: string; supportsCredits: boolean; supportsGuestDemo: boolean; supportsDeveloperDiagnostics?: boolean }>("GET", "/api/capabilities", undefined, guestJar);
  assert(capabilities.product === "boojum", "product=boojum");
  assert(capabilities.mode === "cloud", "mode=cloud");
  assert(capabilities.supportsCredits === true, "supportsCredits=true");
  assert(capabilities.supportsGuestDemo === true, "supportsGuestDemo=true");

  if (!capabilities.supportsDeveloperDiagnostics) {
    const disabled = await raw("POST", "/api/dev/switch-identity", { identity: "guest" }, {});
    assert(disabled.status === 403 || disabled.status === 404, "APP_DEV_UI=false disables /api/dev/switch-identity");
    console.log("PASS cloud smoke: APP_DEV_UI=false guard");
    return;
  }

  await api("POST", "/api/dev/switch-identity", { identity: "guest" }, guestJar);
  const guestAuth = await api<{ user: unknown | null }>("GET", "/api/auth/current", undefined, guestJar);
  assert(guestAuth.user === null, "guest currentUser=null");

  const examples = await api<{ routes: Array<{ filename: string; demoSafe?: boolean; id: string }> }>("GET", "/api/routes/examples", undefined, guestJar);
  const demo = examples.routes.find((route) => route.demoSafe && route.id === "boojum-cloud-polza-image-demo") ?? examples.routes.find((route) => route.demoSafe);
  assert(Boolean(demo), "demo-safe example exists");
  const demoRoute = await api<unknown>("GET", `/api/routes/examples/${encodeURIComponent(demo!.filename)}`, undefined, guestJar);

  const privateRoute = JSON.parse(JSON.stringify(demoRoute)) as Record<string, any>;
  privateRoute.route.id = "private-non-demo-smoke";
  privateRoute.route.tags = [];
  if (privateRoute.provenance) privateRoute.provenance.demoSafe = false;
  const privateRun = await raw("POST", "/api/routes/run", { route: privateRoute }, guestJar);
  assert(privateRun.status === 400 || privateRun.status === 403, "guest cannot run non-demo/private route");

  const run = await api<any>("POST", "/api/routes/run", { route: demoRoute }, guestJar);
  assert(run.status === "succeeded", "guest can run demo-safe route");
  assert(run.costSummary?.totalEstimatedCredits === 40, "demo estimated credits=40");
  assert(run.costSummary?.totalActualCredits === 40, "demo actual credits=40");

  const userJar: CookieJar = {};
  await api("POST", "/api/dev/switch-identity", { identity: "user" }, userJar);
  const userAuth = await api<{ user: { role: string } | null }>("GET", "/api/auth/current", undefined, userJar);
  assert(userAuth.user?.role === "user", "dev user role=user");
  const userAdmin = await raw("GET", "/api/admin/overview", undefined, userJar);
  assert(userAdmin.status === 403, "user cannot access /api/admin/overview");

  const adminJar: CookieJar = {};
  await api("POST", "/api/dev/switch-identity", { identity: "admin" }, adminJar);
  const adminAuth = await api<{ user: { role: string } | null }>("GET", "/api/auth/current", undefined, adminJar);
  assert(adminAuth.user?.role === "admin", "dev admin role=admin");
  const overview = await api<any>("GET", "/api/admin/overview", undefined, adminJar);
  assert(Number(overview.providerUsageCount ?? 0) > 0, "provider_usage_events written");
  const artifactStats = Array.isArray(overview.artifactStats) ? overview.artifactStats : [];
  assert(artifactStats.some((row: any) => Number(row.count ?? 0) > 0), "artifact record written");
  assert(!containsSecret(overview), "admin overview does not expose obvious secrets");

  console.log("PASS cloud smoke: guest demo, artifacts, provider usage, admin guards");
}

async function api<T = unknown>(method: string, path: string, body: unknown, jar: CookieJar): Promise<T> {
  const response = await raw(method, path, body, jar);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return data as T;
}

async function raw(method: string, path: string, body: unknown, jar: CookieJar): Promise<Response> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(Object.keys(jar).length === 0 ? {} : { Cookie: Object.entries(jar).map(([key, value]) => `${key}=${value}`).join("; ") })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const headerList = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? splitSetCookie(response.headers.get("set-cookie"));
  for (const header of headerList) {
    const [pair] = header.split(";");
    const [key, value] = pair.split("=");
    if (key && value) jar[key] = value;
  }
  return response;
}

function splitSetCookie(value: string | null): string[] {
  return value ? value.split(/,\s*(?=[^,]+=)/) : [];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function containsSecret(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /Bearer\s+[A-Za-z0-9._-]+|\bsk-[A-Za-z0-9_-]{8,}|\bsk-or-[A-Za-z0-9_-]{8,}|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i.test(text);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
