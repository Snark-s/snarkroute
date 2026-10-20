import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * How many questions wait for the owner at the Секретарь: rows of the «Решения» sheet with a question and an
 * empty answer (column F). Read-only, with the agent registry's Google service account (the key file is
 * read at call time and never logged or returned).
 */
export const SECRETARY_SHEET_ID = process.env.SECRETARY_SHEET_ID ?? "1Ti-zii3XyT8jP3PtV6-miY8HTCaEu_IcpTTbg62jas8";
export const SECRETARY_KEY_PATH = process.env.SECRETARY_SA_KEY ?? "Y:/Приложения/Tove/data/secrets/google_service_account.json";
const RANGE = "Решения!A2:F1000";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const CACHE_MS = 60_000;

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
export type SecretaryInbox = { pending: number | null; checkedAt: string; error?: string };

/** Rows with a number in A and a question in D; open while F (the answer) is empty. */
export function countPending(values: unknown[][] | undefined): number {
  return (values ?? []).filter(row => /^\d+$/.test(String(row[0] ?? "").trim())
    && String(row[3] ?? "").trim() !== "" && String(row[5] ?? "").trim() === "").length;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function signedAssertion(account: ServiceAccount, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email, scope: SCOPE, aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: nowSeconds, exp: nowSeconds + 3600
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(account.private_key))}`;
}

let token: { value: string; expiresAt: number } | undefined;
let cached: SecretaryInbox | undefined;
let cachedAt = 0;
let inflight: Promise<SecretaryInbox> | undefined;

export async function readSecretaryInbox(options: { fetchImpl?: typeof fetch; keyPath?: string; now?: () => number } = {}): Promise<SecretaryInbox> {
  const now = options.now ?? Date.now;
  if (cached && now() - cachedAt < CACHE_MS) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      if (!token || token.expiresAt - 60_000 < now()) {
        const account = JSON.parse(await readFile(options.keyPath ?? SECRETARY_KEY_PATH, "utf8")) as ServiceAccount;
        const response = await fetchImpl(account.token_uri ?? "https://oauth2.googleapis.com/token", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(account, Math.floor(now() / 1000)) }),
          signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) throw new Error(`Google auth HTTP ${response.status}`);
        const body = await response.json() as { access_token: string; expires_in?: number };
        token = { value: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
      }
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SECRETARY_SHEET_ID}/values/${encodeURIComponent(RANGE)}`;
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token.value}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Google Sheets HTTP ${response.status}`);
      const body = await response.json() as { values?: unknown[][] };
      cached = { pending: countPending(body.values), checkedAt: new Date(now()).toISOString() };
    } catch (error) {
      // Keep the last good number visible; report the failure without any secret material.
      const message = error instanceof Error ? error.message : String(error);
      cached = { pending: cached?.pending ?? null, checkedAt: new Date(now()).toISOString(), error: message.slice(0, 200) };
    }
    cachedAt = now();
    return cached;
  })().finally(() => { inflight = undefined; });
  return inflight;
}
