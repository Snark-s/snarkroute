import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localServiceHome } from "./local-service-endpoints";

/**
 * B3: the owner manages SnarkBridge policy from the Workshop instead of a local CLI.
 * Only two things are editable: a client's access level (D-02, 0..3) and whether level 3 also
 * applies through the OpenAI tunnel. Approvals are one-use, bound to the exact request digest the
 * bridge recorded, and expire; the bridge picks policy changes up without a restart.
 */
export type BridgeClientView = { id: string; accessLevel: number; level3ViaTunnel: boolean; scopes: number; roots: number };
export type BridgePending = { digest: string; client: string; operation: string; summary: string; reason: string; channel?: string; at: string };

const DIGEST = /^[0-9a-f]{64}$/;
const APPROVAL_TTL_S = 600;

export function bridgeConfigPath(home = localServiceHome("snarkbridge")): string {
  if (!home) throw new Error("SnarkBridge не зарегистрирован в реестре служб.");
  return join(home, "bridge-config.json");
}

function readConfig(path: string): any {
  const config = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  if (config.schema_version !== 1 || typeof config.clients !== "object" || typeof config.state_dir !== "string") throw new Error("Политика SnarkBridge повреждена.");
  return config;
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, path);
}

export function readBridgePolicy(path = bridgeConfigPath()) {
  const config = readConfig(path);
  const clients: BridgeClientView[] = Object.entries(config.clients as Record<string, any>).map(([id, client]) => ({
    id, accessLevel: Number(client.access_level ?? 1), level3ViaTunnel: client.level3_via_tunnel === true,
    scopes: Array.isArray(client.scopes) ? client.scopes.length : 0, roots: Array.isArray(client.roots) ? client.roots.length : 0
  }));
  return { clients, localListenerPort: config.local_listener?.port ?? null };
}

export function setBridgeClientLevel(id: string, change: { accessLevel?: number; level3ViaTunnel?: boolean }, path = bridgeConfigPath()) {
  const config = readConfig(path);
  const client = config.clients?.[id];
  if (!client) throw new Error(`Нет клиента моста ${id}.`);
  if (change.accessLevel !== undefined) {
    if (!Number.isInteger(change.accessLevel) || change.accessLevel < 0 || change.accessLevel > 3) throw new Error("Уровень клиента моста — целое число от 0 до 3 (4 — только владелец).");
    client.access_level = change.accessLevel;
  }
  if (change.level3ViaTunnel !== undefined) {
    if (typeof change.level3ViaTunnel !== "boolean") throw new Error("level3ViaTunnel — да или нет.");
    client.level3_via_tunnel = change.level3ViaTunnel;
  }
  writeAtomic(path, `${JSON.stringify(config, null, 2)}`);
  return readBridgePolicy(path).clients.find(item => item.id === id)!;
}

function stateDir(path: string): string { return readConfig(path).state_dir; }

export function listBridgePending(path = bridgeConfigPath()): BridgePending[] {
  const folder = join(stateDir(path), "pending");
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).flatMap(name => {
    try {
      const item = JSON.parse(readFileSync(join(folder, name), "utf8"));
      return [{ digest: item.digest, client: item.client, operation: item.operation, summary: String(item.summary ?? "").slice(0, 2000), reason: item.reason, channel: item.channel, at: item.at }];
    } catch { return []; }
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function decideBridgePending(digest: string, decision: "approve" | "reject", path = bridgeConfigPath(), nowS = Date.now() / 1000) {
  if (!DIGEST.test(digest)) throw new Error("Неверный идентификатор запроса.");
  const pendingPath = join(stateDir(path), "pending", `${digest}.json`);
  if (!existsSync(pendingPath)) throw new Error("Такого ожидающего запроса нет (уже решён или не поступал).");
  const item = JSON.parse(readFileSync(pendingPath, "utf8"));
  if (item.digest !== digest) throw new Error("Запись ожидающего запроса повреждена.");
  if (decision === "reject") { unlinkSync(pendingPath); return { decision, digest }; }
  const approvalId = randomBytes(16).toString("hex");
  writeAtomic(join(stateDir(path), "approvals", `${approvalId}.json`), JSON.stringify({ client: item.client, operation: item.operation, digest, expires: nowS + APPROVAL_TTL_S }));
  return { decision, digest, approvalId, expiresInSeconds: APPROVAL_TTL_S, next: "Агент повторяет тот же запрос — он пройдёт один раз." };
}
