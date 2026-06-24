import { randomBytes, randomUUID, createVerify, createPublicKey } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { getCloudStorage } from "../services/cloud-storage";
import { isCloudStorageConfigured, isProduction } from "../services/env";
import { createLocalCloudSessionToken, hashAuthValue, providerSubjectHash, SESSION_COOKIE_NAME } from "./adapters";

type OAuthProvider = "google" | "yandex";

const STATE_COOKIE_NAME = "boojum_oauth_state";
const NONCE_COOKIE_NAME = "boojum_oauth_nonce";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export async function startOAuth(provider: OAuthProvider, request: FastifyRequest, reply: FastifyReply) {
  assertProductionCloudStorageReady();
  const config = providerConfig(provider);
  const state = randomToken();
  const nonce = randomToken();
  const redirectUri = callbackUrl(provider, request);
  appendSetCookie(reply, cookie(STATE_COOKIE_NAME, state, 600, true));
  if (provider === "google") appendSetCookie(reply, cookie(NONCE_COOKIE_NAME, nonce, 600, true));
  const url = provider === "google"
    ? googleAuthorizeUrl(config.clientId, redirectUri, state, nonce)
    : yandexAuthorizeUrl(config.clientId, redirectUri, state);
  return reply.redirect(url);
}

export async function finishOAuth(provider: OAuthProvider, request: FastifyRequest, reply: FastifyReply) {
  assertProductionCloudStorageReady();
  const query = request.query as Record<string, string | undefined>;
  const code = query.code;
  const state = query.state;
  if (!code || !state) throw new Error("OAuth callback is missing code or state.");
  const expectedState = cookieValue(request, STATE_COOKIE_NAME);
  if (!expectedState || expectedState !== state) throw new Error("OAuth state mismatch.");

  const config = providerConfig(provider);
  const redirectUri = callbackUrl(provider, request);
  const subject = provider === "google"
    ? await googleSubject(code, redirectUri, config.clientId, config.clientSecret, cookieValue(request, NONCE_COOKIE_NAME))
    : await yandexSubject(code, redirectUri, config.clientId, config.clientSecret);
  if (!isCloudStorageConfigured()) {
    appendSetCookie(reply, cookie(SESSION_COOKIE_NAME, createLocalCloudSessionToken(provider, subject, SESSION_MAX_AGE_SECONDS), SESSION_MAX_AGE_SECONDS, true));
    appendSetCookie(reply, cookie(STATE_COOKIE_NAME, "", 0, true));
    appendSetCookie(reply, cookie(NONCE_COOKIE_NAME, "", 0, true));
    return reply.redirect(postAuthRedirectUrl());
  }
  const user = await getCloudStorage().findOrCreateUserByIdentity({ provider, providerSubjectHash: providerSubjectHash(provider, subject) });
  const sessionToken = randomUUID() + "." + randomToken();
  await getCloudStorage().createSession({
    userId: user.id,
    sessionTokenHash: hashAuthValue(sessionToken),
    expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000)
  });
  appendSetCookie(reply, cookie(SESSION_COOKIE_NAME, sessionToken, SESSION_MAX_AGE_SECONDS, true));
  appendSetCookie(reply, cookie(STATE_COOKIE_NAME, "", 0, true));
  appendSetCookie(reply, cookie(NONCE_COOKIE_NAME, "", 0, true));
  return reply.redirect(postAuthRedirectUrl());
}

function assertProductionCloudStorageReady(): void {
  if (isProduction() && !isCloudStorageConfigured()) {
    throw new Error("Cloud auth is not configured. Set DATABASE_URL before using Google or Yandex login.");
  }
}

export function clearSessionCookie(reply: FastifyReply) {
  appendSetCookie(reply, cookie(SESSION_COOKIE_NAME, "", 0, true));
}

function providerConfig(provider: OAuthProvider): { clientId: string; clientSecret: string } {
  const prefix = provider === "google" ? "GOOGLE" : "YANDEX";
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
  if (!clientId || !clientSecret) throw new Error(`${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET are required.`);
  return { clientId, clientSecret };
}

function googleAuthorizeUrl(clientId: string, redirectUri: string, state: string, nonce: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

function yandexAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL("https://oauth.yandex.com/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

async function googleSubject(code: string, redirectUri: string, clientId: string, clientSecret: string, nonce: string | null): Promise<string> {
  if (!nonce) throw new Error("Google OAuth nonce is missing.");
  const token = await postForm<{ id_token?: string }>("https://oauth2.googleapis.com/token", {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  if (!token.id_token) throw new Error("Google did not return an ID token.");
  const claims = await verifyGoogleIdToken(token.id_token, clientId);
  if (claims.nonce !== nonce) throw new Error("Google ID token nonce mismatch.");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("Google ID token subject is missing.");
  return claims.sub;
}

async function yandexSubject(code: string, redirectUri: string, clientId: string, clientSecret: string): Promise<string> {
  const token = await postForm<{ access_token?: string }>("https://oauth.yandex.com/token", {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  if (!token.access_token) throw new Error("Yandex did not return an access token.");
  const response = await fetch("https://login.yandex.ru/info?format=json", {
    headers: { Authorization: `OAuth ${token.access_token}` }
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error("Yandex user info request failed.");
  const subject = stringField(body.psuid) || stringField(body.uid) || stringField(body.id);
  if (!subject) throw new Error("Yandex subject is missing.");
  return subject;
}

async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<Record<string, unknown>> {
  const [headerText, payloadText, signatureText] = idToken.split(".");
  if (!headerText || !payloadText || !signatureText) throw new Error("Google ID token is malformed.");
  const header = JSON.parse(Buffer.from(headerText, "base64url").toString("utf8")) as { kid?: string; alg?: string };
  const claims = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8")) as Record<string, unknown>;
  if (header.alg !== "RS256" || !header.kid) throw new Error("Google ID token uses an unsupported signature.");
  const jwks = await fetchJson<{ keys: Array<Record<string, unknown> & { kid?: string }> }>("https://www.googleapis.com/oauth2/v3/certs");
  const key = jwks.keys.find((entry) => entry.kid === header.kid);
  if (!key) throw new Error("Google signing key was not found.");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerText}.${payloadText}`);
  verifier.end();
  if (!verifier.verify(createPublicKey({ key: key as JsonWebKey, format: "jwk" }), Buffer.from(signatureText, "base64url"))) throw new Error("Google ID token signature is invalid.");
  if (claims.aud !== clientId) throw new Error("Google ID token audience mismatch.");
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("Google ID token issuer mismatch.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Error("Google ID token is expired.");
  return claims;
}

async function postForm<T>(url: string, fields: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields)
  });
  const body = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(`OAuth token exchange failed: ${response.status}`);
  return body;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OAuth metadata request failed: ${response.status}`);
  return await response.json() as T;
}

function callbackUrl(provider: OAuthProvider, request: FastifyRequest): string {
  return `${authBaseUrl(request)}/api/auth/${provider}/callback`;
}

function authBaseUrl(request: FastifyRequest): string {
  const configured = process.env.AUTH_BASE_URL?.trim() || process.env.API_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const host = request.headers.host ?? `127.0.0.1:${process.env.API_PORT ?? 4317}`;
  const proto = isProduction() ? "https" : "http";
  return `${proto}://${host}`;
}

function postAuthRedirectUrl(): string {
  return (process.env.APP_WEB_URL?.trim() || process.env.PUBLIC_APP_URL?.trim() || (isProduction() ? "/" : "http://127.0.0.1:5173")).replace(/\/$/, "");
}

function cookie(name: string, value: string, maxAge: number, httpOnly: boolean): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (httpOnly) parts.push("HttpOnly");
  if (isProduction()) parts.push("Secure");
  return parts.join("; ");
}

function appendSetCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader("Set-Cookie");
  if (!existing) {
    reply.header("Set-Cookie", value);
  } else if (Array.isArray(existing)) {
    reply.header("Set-Cookie", [...existing, value]);
  } else {
    reply.header("Set-Cookie", [String(existing), value]);
  }
}

function cookieValue(request: FastifyRequest, name: string): string | null {
  const cookieHeader = request.headers.cookie ?? "";
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader);
  return match ? decodeURIComponent(match[1]) : null;
}

function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

function stringField(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
