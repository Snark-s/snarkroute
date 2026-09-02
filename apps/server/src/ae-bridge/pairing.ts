import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type AeBridgePairingContext = { remoteAddress: string; origin: string };
export type AeBridgePairingCredential = { token: string; expiresAt: number; expiresInMs: number };

type PairingEntry = { digest: Buffer; contextDigest: Buffer; expiresAt: number };

export class AeBridgePairingService {
  private readonly entries = new Map<string, PairingEntry>();

  constructor(private readonly ttlMs = 15_000) {}

  issue(context: AeBridgePairingContext, now = Date.now()): AeBridgePairingCredential {
    this.prune(now);
    const token = randomBytes(32).toString("base64url");
    const digest = hash(token);
    const expiresAt = now + this.ttlMs;
    this.entries.set(digest.toString("hex"), { digest, contextDigest: hash(contextKey(context)), expiresAt });
    return { token, expiresAt, expiresInMs: this.ttlMs };
  }

  consume(token: string, context: AeBridgePairingContext, now = Date.now()): boolean {
    this.prune(now);
    if (!token) return false;
    const digest = hash(token), key = digest.toString("hex"), entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    if (entry.expiresAt < now || !same(entry.digest, digest)) return false;
    return same(entry.contextDigest, hash(contextKey(context)));
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt < now) this.entries.delete(key);
  }
}

function contextKey(context: AeBridgePairingContext): string {
  return `${normalizeAddress(context.remoteAddress)}\n${normalizeOrigin(context.origin)}`;
}
function normalizeAddress(value: string): string { return value.trim().toLowerCase().replace(/^::ffff:/, ""); }
function normalizeOrigin(value: string): string { const normalized = value.trim().toLowerCase(); if (normalized === "null" || normalized.startsWith("file:")) return "local-file"; return normalized; }
function hash(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function same(left: Buffer, right: Buffer): boolean { return left.length === right.length && timingSafeEqual(left, right); }

export const aeBridgePairingService = new AeBridgePairingService();
