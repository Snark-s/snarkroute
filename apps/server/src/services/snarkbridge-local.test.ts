import { beforeEach, describe, expect, it } from "vitest";
import {
  describeSnarkBridge,
  redactLogText,
  resetSnarkBridgeStateForTests,
  snarkBridgeChildEnv,
  startErrorText,
  trackRelay,
  tunnelMetrics,
  type McpObservation,
  type OwnerProbe,
  type SnarkBridgeOperation,
  type TunnelObservation
} from "./snarkbridge-local";

const NOW = Date.parse("2026-10-15T18:00:00Z");
const nowSeconds = NOW / 1000;

// Shape of a real tunnel-client /metrics page (tunnel id shortened).
function metricsText(options: { lastPoll?: number; start?: number; delivered?: number; failed?: number } = {}) {
  return [
    "# HELP commands_poll_cycles_total cycles",
    `commands_poll_cycles_total{otel_scope_name="controlplane"} 31`,
    `commands_poll_errors_total{error_kind="other",otel_scope_name="controlplane"} 20`,
    `commands_poll_errors_total{error_kind="timeout",otel_scope_name="controlplane"} 10`,
    `commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} ${options.lastPoll ?? 1.792085591e+09}`,
    `http_client_request_duration_seconds_count{http_request_method="GET",http_response_status_code="503",http_route="/v1/tunnels/tunnel_ab12/poll",server_address="api.openai.com"} 8`,
    `http_client_request_duration_seconds_count{http_request_method="POST",http_response_status_code="200",http_route="/v1/tunnels/tunnel_ab12/response",server_address="api.openai.com"} ${options.delivered ?? 0}`,
    `http_client_request_duration_seconds_count{http_request_method="POST",http_response_status_code="503",http_route="/v1/tunnels/tunnel_ab12/response",server_address="api.openai.com"} ${options.failed ?? 0}`,
    `http_client_request_duration_seconds_count{http_request_method="POST",http_response_status_code="200",http_route="/mcp",server_address="127.0.0.1",server_port="8767"} 2`,
    `process_start_time_seconds ${options.start ?? 1.792085493e+09}`
  ].join("\n");
}

const healthyMcp: McpObservation = { listening: true, health: "ok", endpoint: "ok", version: "1.0.0-rc1", bearer: true };
const owned = (port: number, pid: number): OwnerProbe => ({ port, state: "owned", pid });
const owners = { mcp: owned(8767, 101), tunnel: owned(8080, 202) };

function tunnel(lastPollAgeSeconds: number | undefined, extra: { delivered?: number; failed?: number } = {}): TunnelObservation {
  const metrics = tunnelMetrics(metricsText({ lastPoll: lastPollAgeSeconds === undefined ? 0 : nowSeconds - lastPollAgeSeconds, start: nowSeconds - 3600, ...extra }))!;
  return { listening: true, ready: true, metrics };
}

function describe_(input: Partial<Parameters<typeof describeSnarkBridge>[0]>) {
  return describeSnarkBridge({
    mcp: healthyMcp,
    tunnel: tunnel(20),
    owners,
    evidence: { ambiguous: false },
    ownerStopped: false,
    mcpPort: 8767,
    tunnelPort: 8080,
    now: NOW,
    ...input
  });
}

describe("SnarkBridge tunnel metrics", () => {
  it("reads control-plane freshness, poll errors and ChatGPT response delivery", () => {
    const metrics = tunnelMetrics(metricsText({ delivered: 3, failed: 1 }));
    expect(metrics).toMatchObject({ lastPollAt: 1792085591, processStart: 1792085493, pollCycles: 31, delivered: 3, deliveryFailed: 1 });
    expect(metrics?.pollErrors).toEqual({ other: 20, timeout: 10 });
  });

  it("does not mistake another HTTP service for the tunnel", () => {
    expect(tunnelMetrics("go_goroutines 12\nprocess_start_time_seconds 1")).toBeUndefined();
  });
});

describe("SnarkBridge state", () => {
  beforeEach(() => resetSnarkBridgeStateForTests());

  it("is running only with a healthy MCP endpoint and a tunnel polling OpenAI", () => {
    const state = describe_({});
    expect(state.status).toBe("running");
    expect(state.checks.mcpProcess.state).toBe("ok");
    expect(state.checks.mcpEndpoint.state).toBe("ok");
    expect(state.checks.tunnel.state).toBe("ok");
    expect(state.control).toMatchObject({ canStart: false, canStop: true, canRestart: true });
  });

  it("reports MCP running / tunnel disconnected when the control-plane poll is stale", () => {
    const state = describe_({ tunnel: tunnel(22 * 60) });
    expect(state.status).toBe("degraded");
    expect(state.summary).toMatch(/MCP работает · туннель без связи с OpenAI 22 мин/);
    expect(state.checks.tunnel.state).toBe("error");
    expect(state.checks.tunnel.detail).toMatch(/other×20, timeout×10/);
    expect(state.checks.external.state).toBe("error");
    expect(state.control.canStart).toBe(true);
  });

  it("reports MCP running / tunnel not started when the tunnel port is closed", () => {
    const state = describe_({ tunnel: { listening: false, ready: false } });
    expect(state.status).toBe("degraded");
    expect(state.summary).toBe("MCP работает · туннель не запущен");
    expect(state.checks.external.state).toBe("off");
  });

  it("never claims Connected without a delivered ChatGPT response", () => {
    expect(describe_({}).checks.external).toMatchObject({ state: "unknown" });
    expect(describe_({}).checks.external.detail).toMatch(/^Unknown/);
    const delivered = describe_({ evidence: { ambiguous: false, lastDeliveredAt: NOW - 30_000 } }).checks.external;
    expect(delivered.state).toBe("ok");
    expect(delivered.detail).toMatch(/^Connected/);
    const lastFailed = describe_({ evidence: { ambiguous: false, lastDeliveredAt: NOW - 90_000, lastFailedAt: NOW - 10_000 } }).checks.external;
    expect(lastFailed.state).toBe("warning");
    expect(describe_({ evidence: { ambiguous: true, lastDeliveredAt: NOW, lastFailedAt: NOW } }).checks.external.state).toBe("unknown");
  });

  it("dates relay outcomes from counter deltas within one tunnel process", () => {
    const first = tunnelMetrics(metricsText({ start: 1000, failed: 2 }))!;
    expect(trackRelay(first, NOW)).toEqual({ lastFailedAt: 1_000_000, ambiguous: false });
    const later = tunnelMetrics(metricsText({ start: 1000, failed: 2, delivered: 1 }))!;
    expect(trackRelay(later, NOW + 5000)).toEqual({ lastDeliveredAt: NOW + 5000, lastFailedAt: 1_000_000, ambiguous: false });
    const restarted = tunnelMetrics(metricsText({ start: 2000 }))!;
    expect(trackRelay(restarted, NOW + 9000)).toEqual({ ambiguous: false });
  });

  it("is stopped when nothing listens, and says when the owner stopped it", () => {
    const stopped = describe_({ mcp: { listening: false, health: "no-answer", endpoint: "no-answer" }, tunnel: { listening: false, ready: false }, ownerStopped: true });
    expect(stopped.status).toBe("stopped");
    expect(stopped.summary).toMatch(/Watchdog не запустит/);
    expect(stopped.control).toMatchObject({ canStart: true, canStop: false, canRestart: false });
    expect(stopped.checks.mcpProcess.state).toBe("off");
  });

  it("shows Starting and Stopping while an operation runs and blocks further commands", () => {
    const base: SnarkBridgeOperation = { id: "op", action: "start", phase: "starting", startedAt: new Date(NOW - 5000).toISOString(), serverPid: process.pid };
    const starting = describe_({ mcp: { listening: false, health: "no-answer", endpoint: "no-answer" }, tunnel: { listening: false, ready: false }, operation: base });
    expect(starting.status).toBe("starting");
    expect(starting.control).toMatchObject({ canStart: false, canStop: false, canRestart: false });
    const stopping = describe_({ operation: { ...base, action: "stop", phase: "stopping" } });
    expect(stopping.status).toBe("stopping");
    expect(stopping.control.canStop).toBe(false);
  });

  it("keeps a recent start failure visible as Error and allows another start", () => {
    const failed: SnarkBridgeOperation = { id: "op", action: "start", phase: "failed", startedAt: new Date(NOW - 60_000).toISOString(), finishedAt: new Date(NOW - 50_000).toISOString(), error: "нет Python-окружения SnarkBridge (.venv)", serverPid: 1 };
    const state = describe_({ mcp: { listening: false, health: "no-answer", endpoint: "no-answer" }, tunnel: { listening: false, ready: false }, operation: failed });
    expect(state.status).toBe("error");
    expect(state.summary).toMatch(/Не запустился: нет Python-окружения/);
    expect(state.control.canStart).toBe(true);
    const old = describe_({ mcp: { listening: false, health: "no-answer", endpoint: "no-answer" }, tunnel: { listening: false, ready: false }, operation: { ...failed, finishedAt: new Date(NOW - 2 * 3600_000).toISOString() } });
    expect(old.status).toBe("stopped");
  });

  it("refuses to control a tunnel it cannot prove is SnarkBridge's", () => {
    const state = describe_({ tunnel: tunnel(22 * 60), owners: { mcp: owned(8767, 101), tunnel: { port: 8080, state: "unverified", pid: 18848, name: "tunnel-client.exe" } } });
    expect(state.status).toBe("degraded");
    expect(state.control).toMatchObject({ canStart: false, canStop: false, canRestart: false });
    expect(state.control.blockedReason).toMatch(/PID 18848.*правами администратора/);
    expect(state.checks.tunnel.detail).toMatch(/вне Мастерской/);
  });

  it("is an error when another service holds the MCP port or MCP hangs", () => {
    expect(describe_({ mcp: { listening: true, health: "wrong-service", endpoint: "no-answer" } }).status).toBe("error");
    const hung = describe_({ mcp: { listening: true, health: "no-answer", endpoint: "no-answer" } });
    expect(hung.status).toBe("error");
    expect(hung.checks.mcpEndpoint.detail).toMatch(/завис/);
    const tunnelOnly = describe_({ mcp: { listening: false, health: "no-answer", endpoint: "no-answer" } });
    expect(tunnelOnly.status).toBe("error");
    expect(tunnelOnly.summary).toMatch(/MCP-сервер не запущен/);
  });
});

describe("SnarkBridge secrets and diagnostics", () => {
  it("hides keys and tokens in log text", () => {
    const text = redactLogText("key sk-proj-abcdefghijklmnop\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\nCONTROL_PLANE_API_KEY=supersecretvalue1 ok");
    expect(text).not.toMatch(/abcdefghijklmnop|supersecretvalue1/);
    expect(text).toMatch(/CONTROL_PLANE_API_KEY=\[скрыто\] ok/);
  });

  it("starts SnarkBridge without SnarkRoute secrets, launcher token or PowerShell 7 module path", () => {
    const env = snarkBridgeChildEnv({ registryPath: "Y:/registry.json" }, {
      Path: "C:/Windows", USERPROFILE: "C:/Users/me", OPENROUTER_API_KEY: "x", SNARKROUTE_LAUNCHER_TOKEN: "y", PSModulePath: "C:/pwsh", H3_WORKER_SERVICE_TOKEN: "z"
    });
    expect(env).toEqual({ Path: "C:/Windows", USERPROFILE: "C:/Users/me", SNARKROUTE_PORT_REGISTRY: "Y:/registry.json" });
  });

  it("explains START_SNARKBRIDGE.ps1 failures in Russian", () => {
    expect(startErrorText("Unexpected port owner PID=18848")).toMatch(/PID 18848/);
    expect(startErrorText("snarkbridge_tunnel did not become healthy; bounded startup recorded, no automatic termination")).toMatch(/не получил связь с OpenAI/);
    expect(startErrorText("Tunnel credential missing; explicit owner provisioning required")).toMatch(/CONNECT_SNARKBRIDGE\.ps1/);
    expect(startErrorText("something new")).toBe("something new");
  });
});
