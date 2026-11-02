import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Sentinel, SENTINEL_INTERVAL_MS, defaultSentinelTiles, type SentinelRunResult, type SentinelTicket, type SentinelTile } from "./sentinel";
import { repoRoot } from "./system-update";
import { autonomousAppIntent, isAutonomousAppId, startAutonomousApp, type AutonomousAppId, type AutonomousAppIntent } from "./autonomous-apps";

/** First check shortly after startup so the API is already listening. */
export const SENTINEL_FIRST_RUN_MS = 30_000;
/** Passport and "deployed = main" drift is checked once a day (and on the first run after start). */
export const PASSPORT_CHECK_INTERVAL_MS = 24 * 60 * 60_000;

export type PassportCheckResult = { version?: string; errors: string[]; warnings: string[] };

export function sentinelDataDir(root = repoRoot()): string {
  return join(root, "data", "sentinel");
}

/**
 * Keep-alive for the autonomous apps (Шорёк, Фабрика, Бужа). After a reboot or a crash the
 * Sentinel starts them again through the same path as the Workshop button, so they get their
 * own agent identity. An app the owner deliberately stopped is left alone: it is watched only
 * while running, and gets no restart callback.
 */
export function sentinelTiles(options: {
  tiles?: SentinelTile[];
  intent?: (id: AutonomousAppId) => AutonomousAppIntent;
  start?: (id: AutonomousAppId) => Promise<unknown>;
} = {}): SentinelTile[] {
  const intent = options.intent ?? autonomousAppIntent;
  const start = options.start ?? startAutonomousApp;
  return (options.tiles ?? defaultSentinelTiles()).map(tile => {
    if (!isAutonomousAppId(tile.id)) return tile;
    const id = tile.id;
    if (intent(id) === "stopped") return { ...tile, watch: "when_running" as const, restart: undefined };
    return { ...tile, restart: async () => { await start(id); } };
  });
}

/** One ticket per day at most: the drift between the passport, the repositories and what runs. */
export function passportTicket(result: PassportCheckResult, now: Date): SentinelTicket | undefined {
  const problems = [...result.errors.map(e => `ошибка: ${e}`), ...result.warnings.map(w => `расхождение: ${w}`)];
  if (!problems.length) return undefined;
  return {
    tileId: "passport", label: "Паспорт Мастерской", reason: "passport_drift", status: "застрял",
    failuresInWindow: problems.length, detail: problems.join("; ").slice(0, 2000), createdAt: now.toISOString()
  };
}

/** Runs scripts/passport-check.mjs --git --json; a failing check still reports its JSON. */
export function runPassportCheck(root = repoRoot()): Promise<PassportCheckResult> {
  return new Promise(resolve => {
    execFile(process.execPath, [join(root, "scripts", "passport-check.mjs"), "--git", "--json"],
      { cwd: root, timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        try {
          const parsed = JSON.parse(String(stdout || "{}"));
          resolve({ version: parsed.version, errors: parsed.errors ?? [], warnings: parsed.warnings ?? [] });
        } catch {
          resolve({ errors: [`passport-check не запустился: ${error?.message ?? "нет вывода"}`], warnings: [] });
        }
      });
  });
}

/**
 * Wires the Sentinel into a running server:
 *  - GET /api/sentinel returns the latest run (or null before the first one);
 *  - every run writes data/sentinel/pulse.json and latest.json;
 *  - tickets ("застрял") are appended to data/sentinel/tickets.jsonl;
 *  - autonomous apps the owner has not stopped are started again when they are down;
 *  - once a day the passport check (D-12) runs and drift becomes a ticket.
 * Disabled with SNARKROUTE_SENTINEL=0.
 */
export function attachSentinel(app: FastifyInstance, options: {
  dataDir?: string; firstRunMs?: number; intervalMs?: number; sentinel?: Sentinel;
  tiles?: () => SentinelTile[]; passportCheck?: () => Promise<PassportCheckResult>; now?: () => Date;
} = {}): { runNow: () => Promise<SentinelRunResult>; latest: () => SentinelRunResult | null } {
  const dir = options.dataDir ?? sentinelDataDir();
  const now = options.now ?? (() => new Date());
  let latest: SentinelRunResult | null = null;
  let lastPassportAt: number | undefined;
  const write = async (name: string, value: unknown) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), JSON.stringify(value, null, 2), "utf8");
  };
  const appendTicket = async (ticket: SentinelTicket) => {
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "tickets.jsonl"), JSON.stringify(ticket) + "\n", "utf8")
      .catch(error => app.log.warn({ error }, "sentinel ticket write failed"));
  };
  const sentinel = options.sentinel ?? new Sentinel({
    pulseSink: pulse => write("pulse.json", pulse).catch(error => app.log.warn({ error }, "sentinel pulse write failed")),
    ticketSink: appendTicket
  });
  const passport = async (): Promise<SentinelTicket | undefined> => {
    const at = now();
    if (lastPassportAt !== undefined && at.getTime() - lastPassportAt < PASSPORT_CHECK_INTERVAL_MS) return undefined;
    lastPassportAt = at.getTime();
    const result = await (options.passportCheck ?? runPassportCheck)();
    await write("passport.json", { checkedAt: at.toISOString(), ...result }).catch(error => app.log.warn({ error }, "sentinel passport write failed"));
    const ticket = passportTicket(result, at);
    if (ticket) await appendTicket(ticket);
    return ticket;
  };
  const runNow = async () => {
    const result = await sentinel.runOnce((options.tiles ?? sentinelTiles)());
    const drift = await passport().catch(error => { app.log.warn({ error }, "sentinel passport check failed"); return undefined; });
    if (drift) result.tickets = [...result.tickets, drift];
    latest = result;
    await write("latest.json", result).catch(error => app.log.warn({ error }, "sentinel latest write failed"));
    return result;
  };

  app.get("/api/sentinel", async () => ({ ok: true, enabled: process.env.SNARKROUTE_SENTINEL !== "0", latest }));

  if (process.env.SNARKROUTE_SENTINEL !== "0") {
    let interval: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      void runNow().catch(error => app.log.warn({ error }, "sentinel run failed"));
      interval = setInterval(() => { void runNow().catch(error => app.log.warn({ error }, "sentinel run failed")); },
        options.intervalMs ?? SENTINEL_INTERVAL_MS);
      interval.unref?.();
    }, options.firstRunMs ?? SENTINEL_FIRST_RUN_MS);
    first.unref?.();
    app.addHook("onClose", async () => { clearTimeout(first); if (interval) clearInterval(interval); sentinel.stop(); });
  }
  return { runNow, latest: () => latest };
}
