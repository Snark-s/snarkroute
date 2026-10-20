import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { envPath } from "../server-paths";

let loaded = false;
const LOCAL_SETTINGS_ENV_KEYS = [
  "POLZA_AI_API_KEY",
  "RUTRONIX_API_KEY"
];
/** Set by the Мастерская launcher for this particular server process; never taken from .env. */
export const LAUNCHER_OWNED_ENV_KEYS = new Set([
  "API_PORT",
  "PERSONA_BRIDGE_AUTO_START",
  "SNARKROUTE_LAUNCHER_TOKEN",
  "SNARKROUTE_LAUNCHER_CONTROL_PORT"
]);

export function loadRootEnv(): void {
  if (loaded) return;
  if (process.env.SNARKROUTE_LAUNCHER_TOKEN && existsSync(envPath)) {
    // Started by the launcher: its environment is a copy of .env taken when the launcher itself started,
    // so an edited .env (a moved port, a new key) would only arrive after a full launcher restart. The
    // «Перезапустить SnarkRoute» button restarts this process, so the file is re-read here and wins.
    applyEnvFile(dotenv.parse(readFileSync(envPath)), process.env);
  } else {
    dotenv.config({ path: envPath, override: false });
  }
  applyLocalSettingsEnvOverrides();
  loaded = true;
}

/** Copies .env values over the inherited environment, except the keys the launcher owns. */
export function applyEnvFile(parsed: Record<string, string>, env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (!LAUNCHER_OWNED_ENV_KEYS.has(key)) env[key] = value;
  }
}

function applyLocalSettingsEnvOverrides(): void {
  if (process.env.NODE_ENV?.trim().toLowerCase() === "production") return;
  if (!existsSync(envPath)) return;
  const parsed = dotenv.parse(readFileSync(envPath));
  for (const key of LOCAL_SETTINGS_ENV_KEYS) {
    const value = parsed[key]?.trim();
    if (value) process.env[key] = value;
  }
}
