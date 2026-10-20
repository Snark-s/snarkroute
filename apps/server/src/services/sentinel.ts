import { createConnection } from "node:net";
import { localServiceUrl, serviceEndpointRegistry } from "./local-service-endpoints";

export const SENTINEL_INTERVAL_MS = 5 * 60_000;
export const SENTINEL_FAILURE_WINDOW_MS = 60 * 60_000;

export type SentinelOwner = "snarkroute" | "tove" | "foreign" | "unknown" | "none";
export type SentinelStatus = "ok" | "degraded" | "stuck";

export type SentinelTile = {
  id: string;
  label: string;
  url: string;
  healthPath?: string;
  /** The only owners the sentinel may restart. The process itself is never found or killed by port. */
  owner?: Exclude<SentinelOwner, "foreign" | "unknown" | "none">;
  restart?: () => Promise<void>;
};

export type SentinelTicket = {
  tileId: string;
  label: string;
  reason: "health_failed" | "port_conflict" | "restart_failed";
  status: "застрял";
  failuresInWindow: number;
  port?: number;
  portOwner?: SentinelOwner;
  detail: string;
  createdAt: string;
};

export type SentinelTileResult = {
  tileId: string;
  label: string;
  ok: boolean;
  status: SentinelStatus;
  url: string;
  httpStatus?: number;
  error?: string;
  checkedAt: string;
  restarted: boolean;
  portConflict: boolean;
  portOwner?: SentinelOwner;
  failuresInWindow: number;
  ticket?: SentinelTicket;
};

export type SentinelPulse = {
  agent: "snarkroute-sentinel";
  where: "SnarkRoute";
  schedule: "5m";
  lastPulse: string;
  result: "ok" | "ждёт" | "застрял";
  status: "ok" | "ждёт" | "застрял";
  reason?: string;
};

export type SentinelRunResult = {
  checkedAt: string;
  tiles: SentinelTileResult[];
  tickets: SentinelTicket[];
  status: SentinelStatus;
  pulse: SentinelPulse;
};

export type SentinelDependencies = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  portListening?: (port: number) => Promise<boolean>;
  portOwner?: (port: number) => Promise<SentinelOwner>;
  pulseSink?: (pulse: SentinelPulse) => Promise<void> | void;
  ticketSink?: (ticket: SentinelTicket) => Promise<void> | void;
};

type FailureState = { timestamps: number[]; lastTicketAt?: number };

/**
 * Read-only by default. A restart is possible only when the tile supplies both
 * an allowed owner and an explicit restart callback; no process is killed by PID
 * or by whoever happens to occupy a port.
 */
export class Sentinel {
  private readonly failures = new Map<string, FailureState>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly dependencies: SentinelDependencies;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly portListening: (port: number) => Promise<boolean>;
  private readonly portOwner: (port: number) => Promise<SentinelOwner>;

  constructor(dependencies: SentinelDependencies = {}) {
    this.dependencies = dependencies;
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.portListening = dependencies.portListening ?? isPortListening;
    this.portOwner = dependencies.portOwner ?? (async () => "unknown");
  }

  async checkTile(tile: SentinelTile): Promise<SentinelTileResult> {
    const checkedAt = this.now();
    const url = healthUrl(tile);
    const first = await this.probe(url);
    if (first.ok) {
      this.failures.delete(tile.id);
      return {
        tileId: tile.id, label: tile.label, ok: true, status: "ok", url,
        httpStatus: first.httpStatus, checkedAt: checkedAt.toISOString(), restarted: false,
        portConflict: false, failuresInWindow: 0
      };
    }

    const port = portFromUrl(url);
    const listening = port === undefined ? false : await safePortListening(this.portListening, port);
    const portOwner = listening && port !== undefined ? await safePortOwner(this.portOwner, port) : "none";
    const portConflict = listening && portOwner !== tile.owner;
    let restarted = false;
    let finalProbe = first;
    let restartError: string | undefined;

    if (canRestart(tile, listening, portOwner)) {
      try {
        await tile.restart!();
        restarted = true;
        finalProbe = await this.probe(url);
      } catch (error) {
        restartError = errorMessage(error);
      }
    }

    if (finalProbe.ok) {
      this.failures.delete(tile.id);
      return {
        tileId: tile.id, label: tile.label, ok: true, status: "ok", url,
        httpStatus: finalProbe.httpStatus, checkedAt: checkedAt.toISOString(), restarted,
        portConflict, ...(portOwner !== "none" ? { portOwner } : {}), failuresInWindow: 0
      };
    }

    const failuresInWindow = this.recordFailure(tile.id, checkedAt.getTime());
    const reason: SentinelTicket["reason"] = restartError
      ? "restart_failed"
      : portConflict ? "port_conflict" : "health_failed";
    const detail = restartError ?? finalProbe.error ?? `Health check failed for ${tile.label}.`;
    const ticket = failuresInWindow >= 2 ? await this.maybeTicket({
      tile, reason, detail, checkedAt, failuresInWindow, port, portOwner
    }) : undefined;
    return {
      tileId: tile.id, label: tile.label, ok: false,
      status: ticket ? "stuck" : "degraded", url,
      ...(finalProbe.httpStatus !== undefined ? { httpStatus: finalProbe.httpStatus } : {}),
      error: detail, checkedAt: checkedAt.toISOString(), restarted, portConflict,
      ...(portOwner !== "none" ? { portOwner } : {}), failuresInWindow,
      ...(ticket ? { ticket } : {})
    };
  }

  async runOnce(tiles: readonly SentinelTile[]): Promise<SentinelRunResult> {
    const checkedAt = this.now();
    const results: SentinelTileResult[] = [];
    for (const tile of tiles) results.push(await this.checkTile(tile));
    const tickets = results.flatMap(result => result.ticket ? [result.ticket] : []);
    const status: SentinelStatus = results.some(result => result.status === "stuck")
      ? "stuck" : results.some(result => !result.ok) ? "degraded" : "ok";
    const reason = tickets.length
      ? tickets.map(ticket => `${ticket.label}: ${ticket.reason}`).join("; ")
      : results.find(result => !result.ok)?.error;
    const pulse: SentinelPulse = {
      agent: "snarkroute-sentinel", where: "SnarkRoute", schedule: "5m",
      lastPulse: checkedAt.toISOString(), result: status === "stuck" ? "застрял" : status === "ok" ? "ok" : "ждёт",
      status: status === "stuck" ? "застрял" : status === "ok" ? "ok" : "ждёт",
      ...(reason ? { reason } : {})
    };
    await this.dependencies.pulseSink?.(pulse);
    return { checkedAt: checkedAt.toISOString(), tiles: results, tickets, status, pulse };
  }

  /** Starts only the timer. Callers opt into an immediate run explicitly to keep startup side-effect free. */
  start(tiles: readonly SentinelTile[], intervalMs = SENTINEL_INTERVAL_MS): () => void {
    this.stop();
    this.timer = setInterval(() => { void this.runOnce(tiles); }, intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async probe(url: string): Promise<{ ok: boolean; httpStatus?: number; error?: string }> {
    try {
      const response = await this.fetchImpl(url, {
        method: "GET", headers: { Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(2_000)
      });
      if (response.status >= 200 && response.status < 300) return { ok: true, httpStatus: response.status };
      return { ok: false, httpStatus: response.status, error: `Health endpoint returned HTTP ${response.status}.` };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private recordFailure(tileId: string, now: number): number {
    const state = this.failures.get(tileId) ?? { timestamps: [] };
    state.timestamps = state.timestamps.filter(timestamp => now - timestamp <= SENTINEL_FAILURE_WINDOW_MS);
    state.timestamps.push(now);
    this.failures.set(tileId, state);
    return state.timestamps.length;
  }

  private async maybeTicket(input: {
    tile: SentinelTile; reason: SentinelTicket["reason"]; detail: string;
    checkedAt: Date; failuresInWindow: number; port?: number; portOwner: SentinelOwner;
  }): Promise<SentinelTicket | undefined> {
    const state = this.failures.get(input.tile.id)!;
    const at = input.checkedAt.getTime();
    if (state.lastTicketAt !== undefined && at - state.lastTicketAt <= SENTINEL_FAILURE_WINDOW_MS) return undefined;
    state.lastTicketAt = at;
    const ticket: SentinelTicket = {
      tileId: input.tile.id, label: input.tile.label, reason: input.reason,
      status: "застрял", failuresInWindow: input.failuresInWindow,
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.portOwner !== "none" ? { portOwner: input.portOwner } : {}),
      detail: input.detail, createdAt: input.checkedAt.toISOString()
    };
    await this.dependencies.ticketSink?.(ticket);
    return ticket;
  }
}

export function defaultSentinelTiles(): SentinelTile[] {
  const registry = serviceEndpointRegistry();
  return Object.entries(registry.services).flatMap(([id, service]) => {
    if (service.protocol !== "http" || !service.healthPath) return [];
    const owner = id === "tove" || id === "factory" ? "tove" : id === "snarkroute" || id === "bonsai_inference" ? "snarkroute" : undefined;
    const url = `http://${registry.host}:${service.port}`;
    return [{ id, label: id, url, healthPath: service.healthPath, ...(owner ? { owner } : {}) }];
  });
}

/** A named Bonsai check used by the migration test: it must be the registered /v1/models endpoint. */
export function bonsaiSentinelTile(): SentinelTile {
  return { id: "bonsai_inference", label: "Bonsai", url: localServiceUrl("bonsai_inference"), healthPath: "/v1/models", owner: "snarkroute" };
}

function healthUrl(tile: SentinelTile): string {
  const base = new URL(tile.url);
  if (!tile.healthPath) return base.toString();
  base.pathname = tile.healthPath;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function portFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

function canRestart(tile: SentinelTile, listening: boolean, owner: SentinelOwner): boolean {
  if (!tile.restart || !tile.owner || !["snarkroute", "tove"].includes(tile.owner)) return false;
  if (!listening) return true;
  return owner === tile.owner;
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function safePortListening(check: (port: number) => Promise<boolean>, port: number): Promise<boolean> {
  try { return await check(port); } catch { return false; }
}

async function safePortOwner(resolveOwner: (port: number) => Promise<SentinelOwner>, port: number): Promise<SentinelOwner> {
  try { return await resolveOwner(port); } catch { return "unknown"; }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
