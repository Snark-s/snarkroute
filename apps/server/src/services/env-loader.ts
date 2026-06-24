import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { envPath } from "../server-paths";

let loaded = false;
const LOCAL_SETTINGS_ENV_KEYS = [
  "POLZA_AI_API_KEY"
];

export function loadRootEnv(): void {
  if (loaded) return;
  dotenv.config({ path: envPath, override: false });
  applyLocalSettingsEnvOverrides();
  loaded = true;
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
