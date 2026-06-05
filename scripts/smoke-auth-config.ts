import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { loadRootEnv } from "../apps/server/src/services/env-loader";

type Check = { name: string; ok: boolean; detail?: string };

const checks: Check[] = [];

async function main() {
  loadRootEnv();
  const authSecret = env("AUTH_HASH_SECRET");
  const authBaseUrl = env("AUTH_BASE_URL");
  const appWebUrl = env("APP_WEB_URL");
  const isProductionCloud = env("NODE_ENV") === "production" && env("APP_MODE") === "cloud";

  check("AUTH_HASH_SECRET is set", Boolean(authSecret));
  check("AUTH_HASH_SECRET is at least 32 chars", !authSecret || authSecret.length >= 32);
  check("AUTH_BASE_URL is set", Boolean(authBaseUrl));
  check("APP_WEB_URL is set", Boolean(appWebUrl));
  check("AUTH_BASE_URL is a valid URL", !authBaseUrl || isValidUrl(authBaseUrl));
  check("APP_WEB_URL is a valid URL", !appWebUrl || isValidUrl(appWebUrl));

  if (googleAuthEnabled()) {
    check("GOOGLE_CLIENT_ID is set when Google auth is enabled", Boolean(env("GOOGLE_CLIENT_ID")));
    check("GOOGLE_CLIENT_SECRET is set when Google auth is enabled", Boolean(env("GOOGLE_CLIENT_SECRET")));
  }
  if (yandexAuthEnabled()) {
    check("YANDEX_CLIENT_ID is set when Yandex auth is enabled", Boolean(env("YANDEX_CLIENT_ID")));
    check("YANDEX_CLIENT_SECRET is set when Yandex auth is enabled", Boolean(env("YANDEX_CLIENT_SECRET")));
  }

  if (isProductionCloud) {
    check("APP_DEV_UI is false in production cloud", !truthy(env("APP_DEV_UI")));
    check("AUTH_BASE_URL is not localhost in production cloud", !isLocalhostUrl(authBaseUrl));
    check("APP_WEB_URL is not localhost in production cloud", !isLocalhostUrl(appWebUrl));
  }

  if (authSecret) {
    const first = providerSubjectHash("google", "stable-subject-smoke", authSecret);
    const second = providerSubjectHash("google", "stable-subject-smoke", authSecret);
    check("provider_subject_hash is stable for same secret/provider/subject", first === second);
  }

  if (env("DATABASE_URL")) await checkDatabasePrivacy();

  const failed = checks.filter((entry) => !entry.ok);
  for (const entry of checks) console.log(`${entry.ok ? "PASS" : "FAIL"} ${entry.name}${entry.detail ? `: ${entry.detail}` : ""}`);
  if (failed.length > 0) process.exit(1);
}

async function checkDatabasePrivacy() {
  let Pool: any;
  try {
    const require = createRequire(import.meta.url);
    Pool = require("pg").Pool;
  } catch {
    check("DB privacy check can load pg", false, "pg dependency is unavailable");
    return;
  }
  const pool = new Pool({ connectionString: env("DATABASE_URL") });
  try {
    const columns = await pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'auth_identities' and column_name in ('provider_subject', 'provider_subject_hash')"
    );
    const columnNames = new Set(columns.rows.map((row) => row.column_name));
    check("auth_identities has provider_subject_hash", columnNames.has("provider_subject_hash"));

    const rawSubjects = await pool.query<{ count: string }>(
      "select count(*) as count from auth_identities where provider in ('google', 'yandex') and provider_subject is not null"
    );
    check("auth_identities does not store raw provider subject for Google/Yandex", Number(rawSubjects.rows[0]?.count ?? 0) === 0);

    const missingHashes = await pool.query<{ count: string }>(
      "select count(*) as count from auth_identities where provider in ('google', 'yandex') and (provider_subject_hash is null or provider_subject_hash = '')"
    );
    check("auth_identities stores provider_subject_hash for Google/Yandex", Number(missingHashes.rows[0]?.count ?? 0) === 0);

    const userProfileFields = await pool.query<{ count: string }>(
      `
      select count(*) as count
      from auth_identities
      join users on users.id = auth_identities.user_id
      where auth_identities.provider in ('google', 'yandex')
        and (users.email is not null or users.display_name is not null)
      `
    );
    check("real OAuth users do not store email/name", Number(userProfileFields.rows[0]?.count ?? 0) === 0);

    const avatarColumn = await pool.query<{ count: string }>(
      "select count(*) as count from information_schema.columns where table_name = 'users' and column_name in ('avatar', 'avatar_url', 'picture')"
    );
    check("users table has no avatar profile column", Number(avatarColumn.rows[0]?.count ?? 0) === 0);
  } finally {
    await pool.end();
  }
}

function env(key: string): string {
  return process.env[key]?.trim() ?? "";
}

function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
}

function googleAuthEnabled(): boolean {
  return truthy(env("GOOGLE_AUTH_ENABLED")) || Boolean(env("GOOGLE_CLIENT_ID") || env("GOOGLE_CLIENT_SECRET"));
}

function yandexAuthEnabled(): boolean {
  return truthy(env("YANDEX_AUTH_ENABLED")) || Boolean(env("YANDEX_CLIENT_ID") || env("YANDEX_CLIENT_SECRET"));
}

function truthy(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function providerSubjectHash(provider: "google" | "yandex", subject: string, secret: string): string {
  return createHmac("sha256", secret).update(`${provider}${subject}`).digest("hex");
}

function isLocalhostUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
