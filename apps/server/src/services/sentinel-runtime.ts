import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Sentinel, SENTINEL_INTERVAL_MS, defaultSentinelTiles, type SentinelRunResult } from "./sentinel";
import { repoRoot } from "./system-update";

/** First check shortly after startup so the API is already listening. */
export const SENTINEL_FIRST_RUN_MS = 30_000;

export function sentinelDataDir(root = repoRoot()): string {
  return join(root, "data", "sentinel");
}

/**
 * Wires the read-only Sentinel into a running server:
 *  - GET /api/sentinel returns the latest run (or null before the first one);
 *  - every run writes data/sentinel/pulse.json and latest.json;
 *  - tickets ("застрял") are appended to data/sentinel/tickets.jsonl for Шорёк.
 * No tile gets a restart callback here, so the Sentinel never restarts anything.
 * Disabled with SNARKROUTE_SENTINEL=0.
 */
export function attachSentinel(app: FastifyInstance, options: {
  dataDir?: string; firstRunMs?: number; intervalMs?: number; sentinel?: Sentinel;
} = {}): { runNow: () => Promise<SentinelRunResult>; latest: () => SentinelRunResult | null } {
  const dir = options.dataDir ?? sentinelDataDir();
  let latest: SentinelRunResult | null = null;
  const write = async (name: string, value: unknown) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), JSON.stringify(value, null, 2), "utf8");
  };
  const sentinel = options.sentinel ?? new Sentinel({
    pulseSink: pulse => write("pulse.json", pulse).catch(error => app.log.warn({ error }, "sentinel pulse write failed")),
    ticketSink: async ticket => {
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, "tickets.jsonl"), JSON.stringify(ticket) + "\n", "utf8")
        .catch(error => app.log.warn({ error }, "sentinel ticket write failed"));
    }
  });
  const runNow = async () => {
    const result = await sentinel.runOnce(defaultSentinelTiles());
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
