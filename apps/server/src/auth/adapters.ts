import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appDevUi, appMode, isCloudStorageConfigured, isProduction } from "../services/env";
import { getCloudStorage } from "../services/cloud-storage";
import { rememberLocalDevUser } from "../billing/local-dev-credit-store";

export type DevIdentity = "guest" | "user" | "admin";
export type AuthRequestContext = { headers?: { cookie?: string } };

export type AuthUser = {
  id: string;
  displayName?: string;
  email?: string;
  authProvider: "none" | "dev" | "google" | "yandex";
  role: "user" | "admin";
};

export interface AuthAdapter {
  getCurrentUser(request?: AuthRequestContext): Promise<AuthUser | null>;
  requireUser(request?: AuthRequestContext): Promise<AuthUser>;
  login(request?: AuthRequestContext): Promise<AuthUser | null>;
  logout(request?: AuthRequestContext): Promise<{ ok: true }>;
}

export class NoAuthAdapter implements AuthAdapter {
  async getCurrentUser(): Promise<AuthUser | null> {
    return null;
  }

  async requireUser(): Promise<AuthUser> {
    return {
      id: "local",
      displayName: "Local User",
      authProvider: "none",
      role: "admin"
    };
  }

  async login(): Promise<AuthUser | null> {
    return null;
  }

  async logout(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

export class DevAuthAdapter implements AuthAdapter {
  async getCurrentUser(request?: AuthRequestContext): Promise<AuthUser | null> {
    if (!appDevUi()) return this.legacyDevUser();
    const identity = devIdentityFromRequest(request);
    if (identity === "guest") return null;
    return this.devUser(identity);
  }

  async requireUser(request?: AuthRequestContext): Promise<AuthUser> {
    const user = await this.getCurrentUser(request);
    if (!user) throw new Error("Login is required.");
    return user;
  }

  async login(request?: AuthRequestContext): Promise<AuthUser | null> {
    return this.getCurrentUser(request);
  }

  async logout(): Promise<{ ok: true }> {
    return { ok: true };
  }

  private async devUser(identity: Exclude<DevIdentity, "guest">): Promise<AuthUser> {
    const role = identity === "admin" ? "admin" : "user";
    const id = identity === "admin"
      ? "00000000-0000-4000-8000-000000000001"
      : "00000000-0000-4000-8000-000000000002";
    const displayName = identity === "admin" ? "Boojum Dev Admin" : "Boojum Dev User";
    const email = identity === "admin" ? "admin@boojum.local" : "user@boojum.local";
    if (!isCloudStorageConfigured()) {
      rememberLocalDevUser({ id, displayName, authProvider: "dev", role });
      return { id, displayName, email, authProvider: "dev", role };
    }
    const user = await getCloudStorage().ensureUser({ id, displayName, email });
    return {
      id: user.id,
      displayName: user.displayName ?? displayName,
      email: user.email ?? email,
      authProvider: "dev",
      role
    };
  }

  private async legacyDevUser(): Promise<AuthUser> {
    const id = process.env.DEV_USER_ID?.trim();
    if (!id) throw new Error("DEV_USER_ID is required in APP_MODE=cloud dev mode.");
    const displayName = process.env.DEV_USER_NAME?.trim() || "Boojum Cloud Dev";
    const email = process.env.DEV_USER_EMAIL?.trim() || "dev@boojum.local";
    if (!isCloudStorageConfigured()) {
      rememberLocalDevUser({ id, displayName, authProvider: "dev", role: "admin" });
      return { id, displayName, email, authProvider: "dev", role: "admin" };
    }
    const user = await getCloudStorage().ensureUser({ id, displayName, email });
    return {
      id: user.id,
      displayName: user.displayName ?? displayName,
      email: user.email ?? email,
      authProvider: "dev",
      role: user.role ?? "user"
    };
  }
}

export class CloudSessionAuthAdapter implements AuthAdapter {
  async getCurrentUser(request?: AuthRequestContext): Promise<AuthUser | null> {
    const sessionToken = authCookieValue(request, SESSION_COOKIE_NAME);
    if (!sessionToken) return null;
    if (!isCloudStorageConfigured()) return localCloudSessionUser(sessionToken);
    const user = await getCloudStorage().getUserBySession({ sessionTokenHash: hashAuthValue(sessionToken) });
    return user ? { id: user.id, authProvider: "google", role: user.role ?? "user" } : null;
  }

  async requireUser(request?: AuthRequestContext): Promise<AuthUser> {
    const user = await this.getCurrentUser(request);
    if (!user) throw new Error("Login is required.");
    return user;
  }

  async login(request?: AuthRequestContext): Promise<AuthUser | null> {
    return this.getCurrentUser(request);
  }

  async logout(request?: AuthRequestContext): Promise<{ ok: true }> {
    const sessionToken = authCookieValue(request, SESSION_COOKIE_NAME);
    if (!isCloudStorageConfigured()) return { ok: true };
    if (sessionToken) await getCloudStorage().deleteSession({ sessionTokenHash: hashAuthValue(sessionToken) });
    return { ok: true };
  }
}

export function getAuthAdapter(): AuthAdapter {
  if (appMode() !== "cloud") return new NoAuthAdapter();
  return appDevUi() ? new DevAuthAdapter() : new CloudSessionAuthAdapter();
}

export async function requireUser(request?: AuthRequestContext): Promise<AuthUser> {
  return getAuthAdapter().requireUser(request);
}

export async function requireAdmin(request?: AuthRequestContext): Promise<AuthUser> {
  const user = await requireUser(request);
  if (user.role !== "admin") throw new Error("Admin access is required.");
  return user;
}

export async function ensureDevUsers(): Promise<void> {
  if (appMode() !== "cloud" || !appDevUi()) return;
  const adapter = new DevAuthAdapter();
  await adapter.requireUser({ headers: { cookie: "boojum_dev_identity=admin" } });
  await adapter.requireUser({ headers: { cookie: "boojum_dev_identity=user" } });
}

export function devIdentityFromRequest(request?: AuthRequestContext): DevIdentity {
  if (appMode() !== "cloud" || !appDevUi()) return "user";
  const cookie = request?.headers?.cookie ?? "";
  const match = /(?:^|;\s*)boojum_dev_identity=([^;]+)/.exec(cookie);
  const value = match ? decodeURIComponent(match[1]) : "guest";
  return value === "admin" || value === "user" || value === "guest" ? value : "guest";
}

export const SESSION_COOKIE_NAME = "boojum_session";

export function hashAuthValue(value: string): string {
  const secret = process.env.AUTH_HASH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_HASH_SECRET is required for cloud auth.");
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function providerSubjectHash(provider: "google" | "yandex", subject: string): string {
  return hashAuthValue(`${provider}${subject}`);
}

export function createLocalCloudSessionToken(provider: "google" | "yandex", subject: string, maxAgeSeconds: number): string {
  const subjectHash = createHash("sha256").update(`${provider}:${subject}`).digest("hex");
  const payload = Buffer.from(JSON.stringify({
    provider,
    subjectHash,
    exp: Math.floor(Date.now() / 1000) + maxAgeSeconds
  }), "utf8").toString("base64url");
  return `local.${payload}.${localCloudSessionSignature(payload)}`;
}

function localCloudSessionUser(token: string): AuthUser | null {
  const [, payload, signature] = token.split(".");
  if (!payload || !signature || !verifyLocalCloudSessionSignature(payload, signature)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const provider = parsed.provider === "google" || parsed.provider === "yandex" ? parsed.provider : null;
    const subjectHash = typeof parsed.subjectHash === "string" ? parsed.subjectHash : "";
    const exp = typeof parsed.exp === "number" ? parsed.exp : 0;
    if (!provider || !subjectHash || exp * 1000 <= Date.now()) return null;
    const user: AuthUser = {
      id: `local-cloud-${provider}-${subjectHash.slice(0, 16)}`,
      displayName: `Local Cloud ${provider[0].toUpperCase()}${provider.slice(1)} User`,
      authProvider: provider,
      role: "admin"
    };
    rememberLocalDevUser(user);
    return user;
  } catch {
    return null;
  }
}

function localCloudSessionSignature(payload: string): string {
  return createHmac("sha256", localCloudSessionSecret()).update(payload).digest("base64url");
}

function verifyLocalCloudSessionSignature(payload: string, signature: string): boolean {
  const expected = Buffer.from(localCloudSessionSignature(payload));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function localCloudSessionSecret(): string {
  const secret = process.env.AUTH_HASH_SECRET?.trim();
  if (secret) return secret;
  if (isProduction()) throw new Error("AUTH_HASH_SECRET is required for production cloud auth.");
  return "boojum-local-cloud-dev-session-secret";
}

export function authCookieValue(request: AuthRequestContext | undefined, name: string): string | null {
  const cookie = request?.headers?.cookie ?? "";
  const match = new RegExp(`(?:^|;\\s*)${escapeRegExp(name)}=([^;]+)`).exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
