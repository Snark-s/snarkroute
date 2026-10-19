import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import dotenv from "dotenv";
import { envPath, repoRoot } from "../server-paths";
import { localServiceHome, localServicePort } from "./local-service-endpoints";
import { decodeLogBuffer, redactLogText, type ServiceLogSourceDef } from "./service-logs";

export { redactLogText };

/*
 * SnarkBridge (ChatGPT MCP server + OpenAI Secure MCP tunnel) as a Мастерская service.
 * Start is SnarkBridge's own START_SNARKBRIDGE.ps1; stop and ownership checks go through
 * scripts/snarkbridge-control.ps1, which reuses SnarkBridge's snark_services.ps1 rules.
 * Control never depends on the SnarkBridge MCP connection itself, and processes are found
 * by verified port ownership, so a SnarkRoute restart keeps control of running processes.
 */

export type SnarkBridgeState = "running" | "stopped" | "starting" | "stopping" | "error" | "degraded";
export type SnarkBridgeCheckState = "ok" | "warning" | "error" | "off" | "unknown";
export type SnarkBridgeCheck = { state: SnarkBridgeCheckState; detail: string };

export type SnarkBridgeOperation = {
  id: string;
  action: "start" | "stop" | "restart";
  phase: "stopping" | "starting" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** The hidden PowerShell running START_SNARKBRIDGE.ps1 and its log files (without .out.log/.err.log). */
  pid?: number;
  log?: string;
  serverPid: number;
};

export type SnarkBridgeStatus = {
  service: "SnarkBridge";
  status: SnarkBridgeState;
  summary: string;
  running: boolean;
  checks: { mcpProcess: SnarkBridgeCheck; mcpEndpoint: SnarkBridgeCheck; tunnel: SnarkBridgeCheck; external: SnarkBridgeCheck };
  control: { canStart: boolean; canStop: boolean; canRestart: boolean; blockedReason?: string };
  ownerStopped: boolean;
  operation?: SnarkBridgeOperation;
  endpoints: { mcp: string; tunnel: string };
  checkedAt: string;
};

export type SnarkBridgeConfig = {
  home: string;
  mcpPort: number;
  tunnelPort: number;
  registryPath: string;
  controlScript: string;
  stateDir: string;
};

export type OwnerProbe = { port: number; state: "none" | "owned" | "foreign" | "unverified"; pid?: number; parentPid?: number; name?: string; reason?: string };
type OwnerSnapshot = { mcp: OwnerProbe; tunnel: OwnerProbe } | { error: string };

export type McpObservation = {
  listening: boolean;
  health: "ok" | "wrong-service" | "no-answer";
  endpoint: "ok" | "no-answer";
  version?: string;
  bearer?: boolean;
};

export type TunnelMetrics = {
  processStart?: number;
  lastPollAt?: number;
  pollCycles: number;
  pollErrors: Record<string, number>;
  delivered: number;
  deliveryFailed: number;
};

export type TunnelObservation = { listening: boolean; ready: boolean; metrics?: TunnelMetrics };

export type RelayEvidence = { lastDeliveredAt?: number; lastFailedAt?: number; ambiguous: boolean };

/** The same freshness bound SnarkBridge's own Test-SnarkTunnelHealthReport uses. */
export const TUNNEL_POLL_FRESH_SECONDS = 120;
const START_TIMEOUT_MS = 200_000;
const FAILURE_RELEVANT_MS = 30 * 60_000;
const OWNER_PROBE_TTL_MS = 15_000;
const MARKER_NAME = ".owner-stopped.json";
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

let owners: { value: OwnerSnapshot; at: number; listening: string } | undefined;
let ownersInflight: Promise<OwnerSnapshot> | undefined;
let relay: (RelayEvidence & { instance: number; delivered: number; failed: number }) | undefined;
let operation: SnarkBridgeOperation | undefined;
let operationLoaded = false;
let operationLock: Promise<unknown> = Promise.resolve();
let probeOverride: ((config: SnarkBridgeConfig) => Promise<OwnerSnapshot>) | undefined;

export function snarkBridgeConfig(env: NodeJS.ProcessEnv = process.env): SnarkBridgeConfig {
  const home = env.SNARKBRIDGE_HOME?.trim() || localServiceHome("snarkbridge");
  if (!home) throw new Error("Путь к SnarkBridge не задан: paths.snarkbridge в service-endpoints.json.");
  return {
    home,
    mcpPort: localServicePort("snarkbridge_mcp"),
    tunnelPort: localServicePort("snarkbridge_tunnel"),
    registryPath: env.SNARKROUTE_PORT_REGISTRY?.trim() || join(repoRoot, "service-endpoints.json"),
    controlScript: join(repoRoot, "scripts", "snarkbridge-control.ps1"),
    stateDir: env.SNARKBRIDGE_CONTROL_STATE_DIR?.trim() || join(repoRoot, "apps", "server", "data", "snarkbridge")
  };
}

/* ---------- status ---------- */

export async function readSnarkBridgeStatus(options: { freshOwners?: boolean; waitForOwners?: boolean } = {}): Promise<SnarkBridgeStatus> {
  const config = snarkBridgeConfig();
  const [mcp, tunnel] = await Promise.all([observeMcp(config.mcpPort), observeTunnel(config.tunnelPort)]);
  const ownerSnapshot = await readOwners(config, mcp.listening, tunnel.listening, options);
  const evidence = trackRelay(tunnel.metrics);
  const current = settleOperation(config, mcp, tunnel);
  return describeSnarkBridge({
    mcp, tunnel, evidence,
    owners: ownerSnapshot,
    operation: current,
    ownerStopped: existsSync(markerPath(config)),
    mcpPort: config.mcpPort,
    tunnelPort: config.tunnelPort,
    now: Date.now()
  });
}

export function describeSnarkBridge(input: {
  mcp: McpObservation;
  tunnel: TunnelObservation;
  owners?: OwnerSnapshot;
  evidence: RelayEvidence;
  operation?: SnarkBridgeOperation;
  ownerStopped: boolean;
  mcpPort: number;
  tunnelPort: number;
  now: number;
}): SnarkBridgeStatus {
  const { mcp, tunnel, evidence, operation: op, now } = input;
  const ownerSet = input.owners && !("error" in input.owners) ? input.owners : undefined;
  const ownerError = input.owners && "error" in input.owners ? input.owners.error : undefined;
  const pollAge = tunnel.metrics?.lastPollAt ? Math.max(0, now / 1000 - tunnel.metrics.lastPollAt) : undefined;
  const tunnelIsClient = tunnel.listening && (tunnel.ready || Boolean(tunnel.metrics));
  const tunnelConnected = tunnel.ready && pollAge !== undefined && pollAge <= TUNNEL_POLL_FRESH_SECONDS;
  const mcpHealthy = mcp.health === "ok" && mcp.endpoint === "ok";
  const running = mcp.listening || tunnel.listening;

  const mcpOwner = mcp.listening ? ownerSet?.mcp : undefined;
  const tunnelOwner = tunnel.listening ? ownerSet?.tunnel : undefined;
  const blockedOwner = [mcpOwner, tunnelOwner].find(owner => owner?.state === "foreign" || owner?.state === "unverified");
  const blockedReason = blockedOwner ? blockedText(blockedOwner, blockedOwner === mcpOwner ? "MCP" : "туннель") : undefined;

  const checks = {
    mcpProcess: processCheck("MCP", mcp.listening, mcpOwner, ownerError),
    mcpEndpoint: mcpEndpointCheck(mcp, input.mcpPort),
    tunnel: tunnelCheck(tunnel, tunnelIsClient, tunnelConnected, pollAge, tunnelOwner, input.tunnelPort),
    external: externalCheck(tunnel.listening, tunnelConnected, evidence, now)
  };

  let status: SnarkBridgeState;
  let summary: string;
  const busy = op?.phase === "starting" || op?.phase === "stopping";
  // A failed start stays an error until the next command, but not forever (e.g. after a reboot).
  const failed = op?.phase === "failed" && now - Date.parse(op.finishedAt ?? op.startedAt) < FAILURE_RELEVANT_MS;
  if (op?.phase === "stopping") {
    status = "stopping"; summary = "Останавливается: туннель, затем MCP-сервер";
  } else if (op?.phase === "starting" && !(mcpHealthy && tunnelConnected)) {
    status = "starting"; summary = mcpHealthy ? "MCP работает, туннель подключается к OpenAI…" : "Запускается: MCP-сервер и туннель";
  } else if ((mcp.listening && mcp.health === "wrong-service") || (tunnel.listening && !tunnelIsClient) || blockedOwner?.state === "foreign") {
    status = "error";
    summary = blockedReason ?? (mcp.health === "wrong-service" ? `Порт ${input.mcpPort} занят не SnarkBridge` : `Порт ${input.tunnelPort} занят не туннелем SnarkBridge`);
  } else if (!running) {
    status = failed ? "error" : "stopped";
    summary = failed ? `${op!.action === "stop" ? "Ошибка остановки" : "Не запустился"}: ${op!.error ?? "см. журнал"}` : input.ownerStopped ? "Остановлен из Мастерской — Watchdog не запустит его сам" : "Остановлен";
  } else if (mcpHealthy && tunnelConnected) {
    status = "running"; summary = "MCP-сервер и туннель работают";
  } else if (mcpHealthy) {
    status = "degraded";
    summary = !tunnel.listening ? "MCP работает · туннель не запущен"
      : tunnel.metrics?.lastPollAt ? `MCP работает · туннель без связи с OpenAI ${formatAge(pollAge ?? 0)}`
        : "MCP работает · туннель не подключён к OpenAI";
  } else if (mcp.listening) {
    status = "error"; summary = mcp.health === "ok" ? "MCP: /health отвечает, а /mcp — нет" : "MCP-сервер не отвечает (порт открыт)";
  } else {
    status = "error"; summary = "Туннель работает, а MCP-сервер не запущен — ChatGPT получит ошибки";
  }
  if (failed && running && status !== "running" && op!.error) summary += ` · ${op!.action === "stop" ? "остановка" : "запуск"}: ${op!.error}`;

  return {
    service: "SnarkBridge",
    status,
    summary,
    running,
    checks,
    control: {
      canStart: !busy && !blockedOwner && status !== "running",
      canStop: !busy && !blockedOwner && running,
      canRestart: !busy && !blockedOwner && running,
      ...(blockedReason ? { blockedReason } : {})
    },
    ownerStopped: input.ownerStopped,
    ...(op ? { operation: op } : {}),
    endpoints: { mcp: `http://127.0.0.1:${input.mcpPort}/mcp`, tunnel: `http://127.0.0.1:${input.tunnelPort}` },
    checkedAt: new Date(now).toISOString()
  };
}

function processCheck(label: string, listening: boolean, owner: OwnerProbe | undefined, ownerError?: string): SnarkBridgeCheck {
  if (!listening) return { state: "off", detail: "Не запущен" };
  if (ownerError) return { state: "unknown", detail: `Владельца порта проверить не удалось: ${ownerError}` };
  if (!owner || owner.state === "none") return { state: "unknown", detail: "Проверяю процесс-владельца порта…" };
  if (owner.state === "owned") return { state: "ok", detail: `Процесс SnarkBridge · PID ${owner.pid}` };
  return { state: owner.state === "foreign" ? "error" : "warning", detail: blockedText(owner, label) };
}

function blockedText(owner: OwnerProbe, label: string): string {
  return owner.state === "unverified"
    ? `${label}: ${owner.name ?? "процесс"} (PID ${owner.pid}) запущен вне Мастерской с правами администратора или от другого пользователя — его нельзя проверить и остановить отсюда. Закройте его окно, после этого Мастерская возьмёт управление.`
    : `${label}: порт ${owner.port} занят чужим процессом ${owner.name ?? ""} (PID ${owner.pid}). Мастерская его не трогает.`;
}

function mcpEndpointCheck(mcp: McpObservation, port: number): SnarkBridgeCheck {
  if (!mcp.listening) return { state: "off", detail: "Нет ответа: сервер не запущен" };
  if (mcp.health === "wrong-service") return { state: "error", detail: `На порту ${port} отвечает не SnarkBridge` };
  if (mcp.health === "no-answer") return { state: "error", detail: "Порт открыт, но /health не отвечает (процесс завис?)" };
  if (mcp.endpoint !== "ok") return { state: "error", detail: "/health отвечает, но MCP-endpoint /mcp — нет" };
  return { state: "ok", detail: `/health и /mcp отвечают${mcp.version ? ` · v${mcp.version}` : ""}${mcp.bearer ? " · вход по ключу" : ""}` };
}

function tunnelCheck(tunnel: TunnelObservation, isClient: boolean, connected: boolean, pollAge: number | undefined, owner: OwnerProbe | undefined, port: number): SnarkBridgeCheck {
  if (!tunnel.listening) return { state: "off", detail: "Не запущен" };
  if (!isClient) return { state: "error", detail: `Порт ${port} занят, но это не tunnel-client` };
  const outside = owner?.state === "unverified" ? " · запущен вне Мастерской" : "";
  if (connected) return { state: "ok", detail: `На связи с OpenAI · опрос ${formatAge(pollAge ?? 0)} назад${outside}` };
  const errors = formatPollErrors(tunnel.metrics?.pollErrors ?? {});
  if (!tunnel.ready) return { state: "error", detail: `/readyz: не готов${outside}` };
  if (!tunnel.metrics?.lastPollAt) {
    const young = tunnel.metrics?.processStart !== undefined && Date.now() / 1000 - tunnel.metrics.processStart < 90;
    return young ? { state: "warning", detail: `Подключается к OpenAI…${outside}` } : { state: "error", detail: `Ни одного успешного опроса OpenAI с запуска${errors}${outside}` };
  }
  return { state: "error", detail: `Нет связи с OpenAI ${formatAge(pollAge ?? 0)}${errors}${outside}` };
}

function externalCheck(tunnelListening: boolean, connected: boolean, evidence: RelayEvidence, now: number): SnarkBridgeCheck {
  if (!tunnelListening) return { state: "off", detail: "Нет: туннель не запущен" };
  if (!connected) return { state: "error", detail: "Disconnected: туннель не на связи с OpenAI, ChatGPT до SnarkBridge не достучится" };
  const { lastDeliveredAt: ok, lastFailedAt: failed } = evidence;
  if (!evidence.ambiguous && ok !== undefined && (failed === undefined || ok >= failed)) {
    return { state: "ok", detail: `Connected: ответ на запрос ChatGPT доставлен ${formatAge((now - ok) / 1000)} назад` };
  }
  if (!evidence.ambiguous && failed !== undefined && (ok === undefined || failed > ok)) {
    return { state: "warning", detail: `Последний ответ в ChatGPT не доставлен (${formatAge((now - failed) / 1000)} назад)` };
  }
  return { state: "unknown", detail: "Unknown: канал к OpenAI открыт, но свежих запросов из ChatGPT не было — доступность из ChatGPT не подтверждена" };
}

function formatPollErrors(errors: Record<string, number>): string {
  const parts = Object.entries(errors).filter(([, count]) => count > 0).map(([kind, count]) => `${kind}×${count}`);
  return parts.length ? ` · ошибки опроса: ${parts.join(", ")}` : "";
}

export function formatAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} с`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} мин`;
  return `${(seconds / 3600).toFixed(1)} ч`;
}

/* ---------- observations ---------- */

export async function observeMcp(port: number): Promise<McpObservation> {
  if (!await isPortListening(port)) return { listening: false, health: "no-answer", endpoint: "no-answer" };
  let health: McpObservation["health"] = "no-answer";
  let version: string | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
    const body = await response.json() as { ok?: unknown; service?: unknown; apiVersion?: unknown; version?: unknown };
    health = response.ok && body.service === "snarkbridge-mcp" && body.apiVersion === 1 && body.ok === true ? "ok" : "wrong-service";
    if (typeof body.version === "string") version = body.version;
  } catch {}
  let endpoint: McpObservation["endpoint"] = "no-answer";
  let bearer = false;
  if (health === "ok") {
    // An MCP protocol answer, not just an open port: either the Bearer challenge of the authenticated
    // server or a JSON-RPC reply of the open one. Unauthenticated requests are not audited by SnarkBridge.
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "snarkroute-health", method: "ping" }),
        signal: AbortSignal.timeout(2500),
        redirect: "error"
      });
      const text = await response.text();
      bearer = response.status === 401 && /bearer/i.test(response.headers.get("www-authenticate") ?? "");
      if (bearer || (response.ok && text.includes("\"jsonrpc\""))) endpoint = "ok";
    } catch {}
  }
  return { listening: true, health, endpoint, ...(version ? { version } : {}), ...(bearer ? { bearer } : {}) };
}

export async function observeTunnel(port: number): Promise<TunnelObservation> {
  if (!await isPortListening(port)) return { listening: false, ready: false };
  const [ready, metrics] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2000), redirect: "error" })
      .then(async response => response.ok && (await response.text()).trim() === "ready").catch(() => false),
    fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(2500), redirect: "error" })
      .then(async response => response.ok ? tunnelMetrics(await response.text()) : undefined).catch(() => undefined)
  ]);
  return { listening: true, ready, ...(metrics ? { metrics } : {}) };
}

type Sample = { name: string; labels: Record<string, string>; value: number };

export function parsePrometheus(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!match) continue;
    const labels: Record<string, string> = {};
    for (const label of (match[2] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[label[1]] = label[2];
    const value = Number(match[3]);
    if (Number.isFinite(value)) samples.push({ name: match[1], labels, value });
  }
  return samples;
}

/** Only tunnel-client control-plane counters; returns undefined for anything that is not a tunnel-client. */
export function tunnelMetrics(text: string): TunnelMetrics | undefined {
  const samples = parsePrometheus(text);
  if (!samples.some(sample => sample.name === "commands_poll_cycles_total")) return undefined;
  const metrics: TunnelMetrics = { pollCycles: 0, pollErrors: {}, delivered: 0, deliveryFailed: 0 };
  for (const { name, labels, value } of samples) {
    if (name === "process_start_time_seconds") metrics.processStart = value;
    else if (name === "commands_poll_last_successful_timestamp_seconds" && value > 0) metrics.lastPollAt = value;
    else if (name === "commands_poll_cycles_total") metrics.pollCycles += value;
    else if (name === "commands_poll_errors_total") metrics.pollErrors[labels.error_kind || "other"] = (metrics.pollErrors[labels.error_kind || "other"] ?? 0) + value;
    else if (name === "http_client_request_duration_seconds_count" && labels.http_request_method === "POST"
      && /^\/v1\/tunnels\/[^/]+\/response$/.test(labels.http_route ?? "")) {
      // A delivered response is the tunnel answering a ChatGPT request; a missing status is a transport failure.
      if (/^2\d\d$/.test(labels.http_response_status_code ?? "")) metrics.delivered += value;
      else metrics.deliveryFailed += value;
    }
  }
  return metrics;
}

/** Counters are cumulative per tunnel process; their deltas between reads date the latest relay outcome. */
export function trackRelay(metrics: TunnelMetrics | undefined, now = Date.now()): RelayEvidence {
  if (!metrics) return { ambiguous: false };
  const instance = metrics.processStart ?? 0;
  if (!relay || relay.instance !== instance) {
    const since = instance > 0 ? instance * 1000 : now;
    relay = {
      instance, delivered: metrics.delivered, failed: metrics.deliveryFailed,
      ...(metrics.delivered > 0 && metrics.deliveryFailed === 0 ? { lastDeliveredAt: since } : {}),
      ...(metrics.deliveryFailed > 0 && metrics.delivered === 0 ? { lastFailedAt: since } : {}),
      ambiguous: metrics.delivered > 0 && metrics.deliveryFailed > 0
    };
  } else {
    const deliveredMore = metrics.delivered > relay.delivered;
    const failedMore = metrics.deliveryFailed > relay.failed;
    if (deliveredMore) relay.lastDeliveredAt = now;
    if (failedMore) relay.lastFailedAt = now;
    if (deliveredMore || failedMore) relay.ambiguous = deliveredMore && failedMore;
    relay.delivered = metrics.delivered;
    relay.failed = metrics.deliveryFailed;
  }
  return { lastDeliveredAt: relay.lastDeliveredAt, lastFailedAt: relay.lastFailedAt, ambiguous: relay.ambiguous };
}

async function readOwners(config: SnarkBridgeConfig, mcpListening: boolean, tunnelListening: boolean, options: { freshOwners?: boolean; waitForOwners?: boolean }): Promise<OwnerSnapshot | undefined> {
  const listening = `${mcpListening}:${tunnelListening}`;
  const current = owners && Date.now() - owners.at <= OWNER_PROBE_TTL_MS && owners.listening === listening ? owners.value : undefined;
  if (current && !options.freshOwners) return current;
  // An operation needs owners observed after it began, not a probe that was already running.
  if (options.freshOwners && ownersInflight) await ownersInflight.catch(() => undefined);
  const probe = ownersInflight ?? (ownersInflight = (probeOverride ?? probeOwners)(config)
    .catch(error => ({ error: errorMessage(error) }))
    .then(value => { owners = { value, at: Date.now(), listening }; return value; })
    .finally(() => { ownersInflight = undefined; }));
  // Status polls never wait for PowerShell: they show the last verified owners while a new probe runs.
  return options.freshOwners || options.waitForOwners ? probe : owners?.value;
}

async function probeOwners(config: SnarkBridgeConfig): Promise<OwnerSnapshot> {
  const { code, stdout } = await runControl(config, ["-Action", "probe"], 20_000);
  const parsed = lastJson(stdout) as { ok?: boolean; mcp?: OwnerProbe; tunnel?: OwnerProbe } | undefined;
  if (code !== 0 || !parsed?.ok || !parsed.mcp || !parsed.tunnel) throw new Error(`проверка процессов завершилась с кодом ${code}`);
  return { mcp: parsed.mcp, tunnel: parsed.tunnel };
}

/* ---------- operations ---------- */

export async function startSnarkBridge(): Promise<SnarkBridgeStatus> {
  return serialize(async () => {
    const config = snarkBridgeConfig();
    const current = loadOperation(config);
    if (current?.phase === "starting" || current?.phase === "stopping") return readSnarkBridgeStatus();
    const before = await readSnarkBridgeStatus({ freshOwners: true });
    if (before.status === "running") {
      clearMarker(config);
      return before;
    }
    if (before.control.blockedReason) throw new Error(before.control.blockedReason);
    await beginStart(config, newOperation("start"));
    return readSnarkBridgeStatus();
  });
}

export async function stopSnarkBridge(): Promise<SnarkBridgeStatus> {
  return serialize(async () => {
    const config = snarkBridgeConfig();
    const current = loadOperation(config);
    if (current?.phase === "stopping") return readSnarkBridgeStatus();
    const op = newOperation("stop");
    await stopOwned(config, op);
    finishOperation(config, op, "done");
    return readSnarkBridgeStatus({ freshOwners: true });
  });
}

export async function restartSnarkBridge(): Promise<SnarkBridgeStatus> {
  return serialize(async () => {
    const config = snarkBridgeConfig();
    const current = loadOperation(config);
    if (current?.phase === "starting" || current?.phase === "stopping") return readSnarkBridgeStatus();
    const op = newOperation("restart");
    await stopOwned(config, op);
    await beginStart(config, op);
    return readSnarkBridgeStatus();
  });
}

async function stopOwned(config: SnarkBridgeConfig, op: SnarkBridgeOperation) {
  const previous = loadOperation(config);
  // A start still running may not have opened its ports yet; the stop script waits for it on the shared mutex.
  const startInFlight = previous?.phase === "starting" && previous.pid !== undefined && processAlive(previous.pid);
  const before = await readSnarkBridgeStatus({ freshOwners: true });
  if (before.control.blockedReason) throw new Error(before.control.blockedReason);
  // The owner's intent goes on disk first, so the SnarkBridge Watchdog cannot start it again mid-stop or later.
  writeMarker(config);
  op.phase = "stopping";
  saveOperation(config, op);
  appendControlLog(config, `=== ${op.startedAt} ${op.action} ${op.id}: stop requested by Мастерская ===`);
  if (!before.running && !startInFlight) return;
  const { code, stdout, stderr } = await runControl(config, ["-Action", "stop"], 150_000);
  const result = lastJson(stdout) as { ok?: boolean; stopped?: string[]; error?: string } | undefined;
  appendControlLog(config, `stop ${op.id}: exit ${code} ${result ? JSON.stringify(result) : tail(stderr || stdout, 600)}`);
  invalidateOwners();
  if (code === 0 && result?.ok) return;
  const raw = result?.error || tail(stderr || stdout, 400) || `код ${code}`;
  // Nothing was touched when ownership or the lock refused the stop: the previous state stands, so the marker goes.
  if (/^(owner-|lock-timeout)/.test(raw)) clearMarker(config);
  const error = stopErrorText(raw);
  finishOperation(config, op, "failed", error);
  throw new Error(error);
}

async function beginStart(config: SnarkBridgeConfig, op: SnarkBridgeOperation) {
  clearMarker(config);
  op.phase = "starting";
  mkdirSync(config.stateDir, { recursive: true });
  pruneStartLogs(config);
  op.log = join(config.stateDir, `start-${op.id}`);
  saveOperation(config, op);
  appendControlLog(config, `=== ${new Date().toISOString()} ${op.action} ${op.id}: start requested by Мастерская ===`);
  invalidateOwners();
  // A short helper hands START_SNARKBRIDGE.ps1 to its own hidden PowerShell and returns its PID.
  const { code, stdout, stderr } = await runControl(config, ["-Action", "launch", "-LogPrefix", op.log], 30_000)
    .catch(error => ({ code: -1, stdout: "", stderr: errorMessage(error) }));
  const launched = lastJson(stdout) as { ok?: boolean; pid?: number } | undefined;
  if (code !== 0 || !launched?.ok || !launched.pid) {
    const error = `Не удалось запустить скрипт запуска: ${tail(stderr || stdout, 300) || `код ${code}`}`;
    finishOperation(config, op, "failed", error);
    throw new Error(error);
  }
  op.pid = launched.pid;
  saveOperation(config, op);
  appendControlLog(config, `start ${op.id}: START_SNARKBRIDGE.ps1 runs in PID ${op.pid}`);
}

function settleOperation(config: SnarkBridgeConfig, mcp: McpObservation, tunnel: TunnelObservation): SnarkBridgeOperation | undefined {
  const op = loadOperation(config);
  if (!op) return undefined;
  if (op.phase === "stopping" && op.serverPid !== process.pid) {
    finishOperation(config, op, "failed", "Остановка прервана перезапуском SnarkRoute — проверьте состояние и повторите");
  } else if (op.phase === "starting" && op.pid) {
    const fresh = tunnel.metrics?.lastPollAt !== undefined && Date.now() / 1000 - tunnel.metrics.lastPollAt <= TUNNEL_POLL_FRESH_SECONDS;
    const result = startResult(op);
    if (mcp.health === "ok" && mcp.endpoint === "ok" && tunnel.ready && fresh) finishOperation(config, op, "done");
    else if (result?.ok === false) finishOperation(config, op, "failed", result.error);
    else if (result?.ok) finishOperation(config, op, "done");
    else if (!processAlive(op.pid)) finishOperation(config, op, "failed", "Скрипт запуска завершился без результата — см. журнал");
    else if (Date.now() - Date.parse(op.startedAt) > START_TIMEOUT_MS) finishOperation(config, op, "failed", `Запуск не завершился за ${Math.round(START_TIMEOUT_MS / 1000)} с`);
  } else if (op.phase === "starting" && Date.now() - Date.parse(op.startedAt) > 60_000) {
    finishOperation(config, op, "failed", "Запуск прерван до старта скрипта");
  }
  return op;
}

function newOperation(action: SnarkBridgeOperation["action"]): SnarkBridgeOperation {
  return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, action, phase: "starting", startedAt: new Date().toISOString(), serverPid: process.pid };
}

function finishOperation(config: SnarkBridgeConfig, op: SnarkBridgeOperation, phase: "done" | "failed", error?: string) {
  op.phase = phase;
  op.finishedAt = new Date().toISOString();
  if (error) op.error = error; else delete op.error;
  saveOperation(config, op);
  if (phase === "failed") appendControlLog(config, `${op.action} ${op.id} failed: ${error}`);
}

function loadOperation(config: SnarkBridgeConfig): SnarkBridgeOperation | undefined {
  if (!operationLoaded) {
    operationLoaded = true;
    try { operation = JSON.parse(readFileSync(join(config.stateDir, "operation.json"), "utf8")) as SnarkBridgeOperation; } catch {}
  }
  return operation;
}

function saveOperation(config: SnarkBridgeConfig, op: SnarkBridgeOperation) {
  operation = op;
  operationLoaded = true;
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(join(config.stateDir, "operation.json"), JSON.stringify(op, null, 2), "utf8");
}

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = operationLock.then(task, task);
  operationLock = next.catch(() => undefined);
  return next;
}

/* ---------- owner-stop marker (read by START_SNARKBRIDGE.ps1, so Watchdog honours a stop) ---------- */

function markerPath(config: SnarkBridgeConfig) {
  return join(config.home, MARKER_NAME);
}

function writeMarker(config: SnarkBridgeConfig) {
  writeFileSync(markerPath(config), JSON.stringify({ stoppedAt: new Date().toISOString(), by: "SnarkRoute Мастерская" }), "utf8");
}

function clearMarker(config: SnarkBridgeConfig) {
  rmSync(markerPath(config), { force: true });
}

/* ---------- logs ---------- */

export type SnarkBridgeLogSource = { id: string; title: string; file: string; text: string; updatedAt?: string };

export function readSnarkBridgeLogs(): { sources: SnarkBridgeLogSource[] } {
  const sources: SnarkBridgeLogSource[] = [];
  for (const source of snarkBridgeLogSources()) {
    // The card's "start" entry already merges the error stream.
    if (source.id === "start-errors" || !source.path || !existsSync(source.path)) continue;
    const stat = statSync(source.path);
    const text = source.id === "start" ? startLogText(source.path.replace(/\.out\.log$/, "")) : decodeLog(readTail(source.path, 96_000));
    sources.push({ id: source.id, title: source.title, file: source.path, text: redactLogText(tailLines(text, SOURCE_TAIL_LINES[source.id] ?? 40)), updatedAt: stat.mtime.toISOString() });
  }
  return { sources };
}

const SOURCE_TAIL_LINES: Record<string, number> = { control: 80, start: 80, watchdog: 60, tunnel: 40, events: 20 };

/** SnarkBridge keeps its own logs; the Мастерская terminals read them, SnarkRoute never rotates them. */
export function snarkBridgeLogSources(): ServiceLogSourceDef[] {
  const config = snarkBridgeConfig();
  const workspace = join(config.home, "workspace");
  const lastStart = newestNonEmpty(config.stateDir, /^start-.*\.out\.log$/);
  const lastStartErrors = lastStart ? lastStart.replace(/\.out\.log$/, ".err.log") : undefined;
  const sources: Array<ServiceLogSourceDef | undefined> = [
    { id: "control", title: "Команды Мастерской", path: controlLogPath(config), owner: "own-file" },
    lastStart ? { id: "start", title: "Последний запуск", path: lastStart, owner: "own-file" } : undefined,
    lastStartErrors && existsSync(lastStartErrors) ? { id: "start-errors", title: "Ошибки запуска", path: lastStartErrors, owner: "own-file" } : undefined,
    { id: "watchdog", title: "Watchdog и автозапуск", path: join(workspace, "scheduled-startup.log"), owner: "own-file" },
    { id: "tunnel", title: "Туннель (stderr)", path: newestNonEmpty(workspace, /^snarkbridge-tunnel-start-.*\.stderr\.log$/), owner: "own-file" },
    { id: "events", title: "Event driver", path: join(workspace, "event-driver.log"), owner: "own-file" }
  ];
  return sources.filter((source): source is ServiceLogSourceDef => Boolean(source));
}

function decodeLog(buffer: Buffer): string {
  return decodeLogBuffer(buffer);
}

function readTail(path: string, bytes: number): Buffer {
  const buffer = readFileSync(path);
  return buffer.length > bytes ? buffer.subarray(buffer.length - bytes) : buffer;
}

function tailLines(text: string, count: number): string {
  return text.split(/\r?\n/).filter(line => line.trim()).slice(-count).join("\n");
}

function newestNonEmpty(directory: string, pattern: RegExp): string | undefined {
  try {
    return readdirSync(directory)
      .filter(name => pattern.test(name))
      .map(name => ({ path: join(directory, name), stat: statSync(join(directory, name)) }))
      .filter(entry => entry.stat.size > 0)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]?.path;
  } catch {
    return undefined;
  }
}

function controlLogPath(config: SnarkBridgeConfig) {
  return join(config.stateDir, "control.log");
}

function appendControlLog(config: SnarkBridgeConfig, line: string) {
  try {
    mkdirSync(config.stateDir, { recursive: true });
    appendFileSync(controlLogPath(config), `${line}\n`, "utf8");
  } catch {}
}

function startLogText(prefix: string): string {
  return [".out.log", ".err.log"].map(suffix => {
    try { return decodeLog(readTail(prefix + suffix, 48_000)); } catch { return ""; }
  }).filter(Boolean).join("\n");
}

function startResult(op: SnarkBridgeOperation): { ok: true } | { ok: false; error: string } | undefined {
  if (!op.log) return undefined;
  const text = startLogText(op.log);
  const failed = /SNARKBRIDGE_CONTROL_START_FAILED:\s*(.+)/.exec(text);
  if (failed) return { ok: false, error: startErrorText(failed[1].trim()) };
  return text.includes("SNARKBRIDGE_CONTROL_START_OK") ? { ok: true } : undefined;
}

function pruneStartLogs(config: SnarkBridgeConfig) {
  try {
    const logs = readdirSync(config.stateDir).filter(name => /^start-.*\.(out|err)\.log$/.test(name))
      .map(name => ({ path: join(config.stateDir, name), mtime: statSync(join(config.stateDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of logs.slice(20)) rmSync(old.path, { force: true });
  } catch {}
}

export function startErrorText(raw: string): string {
  const known: Array<[RegExp, string]> = [
    [/Unexpected port owner PID=(\d+)/, "порт SnarkBridge занят процессом PID $1, который не удалось подтвердить как SnarkBridge (запущен вручную с правами администратора?)"],
    [/snarkbridge_tunnel did not become healthy/, "туннель не получил связь с OpenAI за отведённые 50 с (если процесс туннеля жив, он продолжит попытки)"],
    [/snarkbridge_mcp did not become healthy/, "MCP-сервер не прошёл проверку /health: завершился при старте или не ответил за 50 с"],
    [/Tunnel credential missing|Owner-provisioned tunnel credential missing/, "нет сохранённого ключа туннеля (.tunnel-key.dpapi): один раз запустите CONNECT_SNARKBRIDGE.ps1 вручную и введите ключ"],
    [/Python environment missing/, "нет Python-окружения SnarkBridge (.venv)"],
    [/Another SnarkBridge (start|operation) is running/, "SnarkBridge уже запускается другим процессом (Watchdog) — повторите через минуту"],
    [/Tunnel diagnostics failed/, "диагностика туннеля (tunnel-client doctor) не прошла"],
    [/listening but unhealthy/, "процесс слушает порт, но не проходит проверку здоровья; повторный запуск его перезапустит"],
    [/Configure SNARKROUTE_PORT_REGISTRY|service registry/i, "SnarkBridge не нашёл service-endpoints.json"]
  ];
  for (const [pattern, text] of known) {
    const match = pattern.exec(raw);
    if (match) return text.replace("$1", match[1] ?? "");
  }
  return raw.slice(0, 300);
}

function stopErrorText(raw: string): string {
  if (/^lock-timeout/.test(raw)) return "Остановка не выполнена: SnarkBridge в этот момент запускается (Watchdog). Повторите через минуту.";
  if (/^port-still-open/.test(raw)) return `Процесс остановлен не полностью: ${raw.replace(/^port-still-open:\s*/, "")} ещё открыт`;
  const owner = /^owner-(unverified|foreign): (\w+) port (\d+) is held by PID (\d+) \(([^)]*)\)/.exec(raw);
  if (owner) {
    return owner[1] === "unverified"
      ? `Остановка отменена: ${owner[2] === "tunnel" ? "туннель" : "MCP"} (PID ${owner[4]}, ${owner[5]}) запущен вне Мастерской с правами администратора — его нельзя остановить отсюда. Ничего не остановлено.`
      : `Остановка отменена: порт ${owner[3]} занят чужим процессом PID ${owner[4]} (${owner[5]}). Ничего не остановлено.`;
  }
  return `Остановка не удалась: ${raw.slice(0, 300)}`;
}

/* ---------- process helpers ---------- */

function powershellArgs(config: SnarkBridgeConfig, args: string[]) {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", config.controlScript, ...args, "-BridgeHome", config.home];
}

function runControl(config: SnarkBridgeConfig, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (process.platform !== "win32") return Promise.reject(new Error("Управление SnarkBridge доступно только в Windows."));
  if (!existsSync(join(config.home, "snark_services.ps1"))) return Promise.reject(new Error(`SnarkBridge не найден: ${config.home}`));
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", powershellArgs(config, args), {
      cwd: config.home, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false, env: snarkBridgeChildEnv(config)
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`PowerShell не ответил за ${Math.round(timeoutMs / 1000)} с`)); }, timeoutMs);
    child.stdout?.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-20_000); });
    child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-20_000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * SnarkBridge gets the user's ordinary environment, as from its own scheduled task, without the SnarkRoute
 * .env provider keys and launcher token: SnarkBridge passes its environment on to the services it starts.
 */
export function snarkBridgeChildEnv(config: Pick<SnarkBridgeConfig, "registryPath">, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  let rootKeys = new Set<string>();
  try { rootKeys = new Set(Object.keys(dotenv.parse(readFileSync(envPath))).map(key => key.toUpperCase())); } catch {}
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (value === undefined || rootKeys.has(upper) || SECRET_NAME.test(upper) || upper.startsWith("SNARKROUTE_")
      || upper === "PSMODULEPATH" || upper === "API_PORT" || upper.startsWith("NODE_") || upper.startsWith("VITE_")) continue;
    env[key] = value;
  }
  env.SNARKROUTE_PORT_REGISTRY = config.registryPath;
  return env;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function invalidateOwners() {
  owners = undefined;
}

function lastJson(text: string): unknown {
  const line = text.split(/\r?\n/).map(value => value.trim()).filter(value => value.startsWith("{")).pop();
  if (!line) return undefined;
  try { return JSON.parse(line); } catch { return undefined; }
}

function tail(text: string, max: number): string {
  const value = text.trim();
  return value.length > max ? value.slice(value.length - max) : value;
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(700, () => { socket.destroy(); resolve(false); });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ---------- test hooks ---------- */

export function setSnarkBridgeOwnerProbeForTests(probe: ((config: SnarkBridgeConfig) => Promise<OwnerSnapshot>) | undefined) {
  probeOverride = probe;
  owners = undefined;
}

export function resetSnarkBridgeStateForTests() {
  owners = undefined;
  ownersInflight = undefined;
  relay = undefined;
  operation = undefined;
  operationLoaded = false;
  operationLock = Promise.resolve();
}
