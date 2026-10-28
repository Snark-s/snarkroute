import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { localServiceHome } from "./local-service-endpoints";

const DURATION = 28_800;
const home = () => localServiceHome("snarkbridge");
const leasePath = () => {
  const dir = home();
  return dir ? join(dir, ".owner-y-process-lease.json") : undefined;
};
const ownerLauncher = () => {
  const dir = home();
  return dir ? join(dir, "ENABLE_Y_ACCESS.cmd") : undefined;
};
export type YAccess = {
  installed: boolean;
  enabled: boolean;
  expiresAt?: string;
  secondsRemaining: number;
  durationSeconds: number;
  scope: string;
};
export function readYAccess(): YAccess {
  const installed = Boolean(ownerLauncher() && existsSync(ownerLauncher()!));
  const base: YAccess = {
    installed, enabled: false, secondsRemaining: 0,
    durationSeconds: DURATION, scope: "Y: project scripts and read-only Git"
  };
  const path = leasePath();
  if (!path) return base;
  try {
    const item = JSON.parse(readFileSync(path, "utf8")) as {
      client?: string; duration?: number; expires?: number
    };
    if (item.client !== "chatgpt" || item.duration !== DURATION || typeof item.expires !== "number" || !Number.isFinite(item.expires)) return base;
    const remaining = Math.max(0, item.expires! - Math.floor(Date.now() / 1000));
    return remaining > 0 ? {
      ...base, enabled: true, secondsRemaining: remaining,
      expiresAt: new Date(item.expires! * 1000).toISOString()
    } : base;
  } catch { return base; }
}
/** Browser request never grants rights. It only opens an interactive local owner console. */
export function requestYAccessApproval(): void {
  const script = ownerLauncher();
  if (!script || !existsSync(script)) throw new Error("Local SnarkBridge owner add-on not installed.");
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", script], {
    cwd: home(), detached: true, stdio: "ignore", windowsHide: false
  });
  child.once("error", () => {});
  child.unref();
}
/** Revocation-only operation; never writes an enabling grant over HTTP. */
export function revokeYAccess(): YAccess {
  const path = leasePath();
  if (path) rmSync(path, { force: true });
  return readYAccess();
}
