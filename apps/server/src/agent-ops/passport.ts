import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../server-paths";

/**
 * Workshop passport (decision D-12): every agent learns where the Workshop map and the
 * owner's binding decisions live, by mechanism rather than by request. The version is read
 * at runtime from docs/workshop-passport.json so it never goes stale in code.
 */
export const PASSPORT_DOC = "docs/WORKSHOP-PASSPORT.md";
export const DECISIONS_DOC = "docs/decisions/REGISTRY.md";

export function readPassportVersion(root: string = repoRoot): string | null {
  try {
    const value = JSON.parse(readFileSync(join(root, "docs", "workshop-passport.json"), "utf8"))?.passportVersion;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function passportBriefLine(version: string | null = readPassportVersion()): string {
  const versionText = version ? `passport version ${version}` : "passport version unavailable: docs/workshop-passport.json could not be read";
  return `Workshop map and the owner's binding decisions: ${PASSPORT_DOC} and ${DECISIONS_DOC} (${versionText}). Read them before any design, before declaring a task impossible and before creating a new registry, subsystem or function; accepted decisions are binding.`;
}
