import { buildServer } from "../apps/server/src/app";

type Check = { name: string; ok: boolean; detail?: string };

const checks: Check[] = [];
const SECRET_KEYS = ["GOOGLE_CLIENT_SECRET", "YANDEX_CLIENT_SECRET", "AUTH_HASH_SECRET"] as const;

async function main() {
  const previous = snapshotEnv(["SNARKROUTE_NO_LISTEN", "APP_DEV_UI", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  process.env.SNARKROUTE_NO_LISTEN = "1";
  process.env.APP_DEV_UI = "false";

  try {
    await checkConfiguredGoogleStart();
    await checkMissingGoogleStart();
  } finally {
    restoreEnv(previous);
  }

  const failed = checks.filter((entry) => !entry.ok);
  for (const entry of checks) console.log(`${entry.ok ? "PASS" : "FAIL"} ${entry.name}${entry.detail ? `: ${entry.detail}` : ""}`);
  if (failed.length > 0) process.exit(1);
}

async function checkConfiguredGoogleStart() {
  const app = buildServer();
  try {
    const response = await app.inject({ method: "GET", url: "/api/auth/google/start" });
    const location = response.headers.location;
    check("server runtime sees Google OAuth config", response.statusCode === 302 && typeof location === "string" && location.startsWith("https://accounts.google.com/o/oauth2/v2/auth"));
    check("server runtime auth response does not expose secrets", !containsSecretValue(response.body) && !containsSecretValue(String(location ?? "")));
  } finally {
    await app.close();
  }
}

async function checkMissingGoogleStart() {
  const previous = snapshotEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;

  const app = buildServer();
  try {
    const response = await app.inject({ method: "GET", url: "/api/auth/google/start" });
    const body = response.json() as { error?: string };
    check("server runtime reports missing Google OAuth config clearly", response.statusCode === 500 && body.error === "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.");
  } finally {
    await app.close();
    restoreEnv(previous);
  }
}

function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
}

function containsSecretValue(text: string): boolean {
  return SECRET_KEYS.some((key) => {
    const value = process.env[key]?.trim();
    return Boolean(value && text.includes(value));
  });
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
