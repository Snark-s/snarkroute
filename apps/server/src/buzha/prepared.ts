import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buzhaHome } from "./memory";

/** Requests other agents prepared for the owner: listed read-only; only the owner's own session submits one. */
export type PreparedBuzhaRequest = { file: string; title: string; preparedBy: string; preparedAt: string; summary: string[]; body: { content: string; requestKey: string; quality?: "normal" | "high"; contract?: Record<string, unknown> } };

export function buzhaPreparedDir(home = buzhaHome()) { return join(home, "data", "prepared-requests"); }

export async function buzhaPrepared(dir = buzhaPreparedDir()): Promise<PreparedBuzhaRequest[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter(file => /^[\w.-]{1,120}\.json$/.test(file)).sort();
  const prepared: PreparedBuzhaRequest[] = [];
  for (const file of files) {
    try {
      const value = JSON.parse(await readFile(join(dir, file), "utf8"));
      const body = value.body;
      if (typeof value.title !== "string" || typeof body?.content !== "string" || typeof body.requestKey !== "string" || body.content.length > 40000) continue;
      prepared.push({ file, title: value.title.slice(0, 200), preparedBy: String(value.preparedBy ?? "").slice(0, 100), preparedAt: String(value.preparedAt ?? ""),
        summary: Array.isArray(value.summary) ? value.summary.map(String).slice(0, 20) : [], body: { content: body.content, requestKey: body.requestKey, quality: body.quality === "high" ? "high" : "normal", contract: body.contract } });
    } catch { /* a malformed proposal is not shown */ }
  }
  return prepared;
}
