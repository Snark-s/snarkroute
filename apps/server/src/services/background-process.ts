import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../server-paths";

/*
 * Windowless start of long-lived local services, shared by every launcher in the server.
 * The work is done by scripts/windowless-launch.mjs (see its header for the Windows details):
 * no console window, stdout/stderr appended to a rotating log file, and the service survives
 * a SnarkRoute restart. The service PID is reported so callers can watch it and stop its tree.
 */

export type BackgroundLaunchSpec = {
  label: string;
  command: string;
  args?: string[];
  cwd: string;
  logPath: string;
  env?: NodeJS.ProcessEnv;
};

export type BackgroundLaunch = {
  pid?: number;
  trampolinePid?: number;
  exitedEarly?: boolean;
  exitCode?: number | null;
  logPath: string;
};

/** Environment for Python services whose output goes to a log: lines appear live and Cyrillic is not mangled. */
export const PYTHON_LOG_ENV = { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" } as const;

export function windowlessLaunchScript(): string {
  return join(repoRoot, "scripts", "windowless-launch.mjs");
}

export function launchBackgroundService(spec: BackgroundLaunchSpec, timeoutMs = 20_000): Promise<BackgroundLaunch> {
  const payload = Buffer.from(JSON.stringify({
    label: spec.label, command: spec.command, args: spec.args ?? [], cwd: spec.cwd, log: spec.logPath
  }), "utf8").toString("base64url");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [windowlessLaunchScript(), payload], {
      cwd: spec.cwd, env: spec.env ?? process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${spec.label}: фоновый запуск не ответил за ${Math.round(timeoutMs / 1000)} с`)); }, timeoutMs);
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", () => {
      clearTimeout(timer);
      try {
        const report = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "") as BackgroundLaunch & { ok?: boolean; error?: string; log?: string };
        if (!report.ok) { reject(new Error(`${spec.label}: ${report.error ?? "фоновый запуск не удался"}`)); return; }
        resolve({
          logPath: spec.logPath,
          ...(report.pid ? { pid: report.pid } : {}),
          ...(report.trampolinePid ? { trampolinePid: report.trampolinePid } : {}),
          ...(report.exitedEarly ? { exitedEarly: true, exitCode: report.exitCode ?? null } : {})
        });
      } catch {
        reject(new Error(`${spec.label}: фоновый запуск не удался ${(stderr || stdout).trim().slice(-600)}`));
      }
    });
  });
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Polls a PID that is not our child (the service outlives the launch shim) and reports its end once. */
export function watchProcessExit(pid: number, onExit: () => void, intervalMs = 1500): () => void {
  const timer = setInterval(() => {
    if (processAlive(pid)) return;
    clearInterval(timer);
    onExit();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Ends a process together with every child it started (venv launchers, runners, cmd wrappers). */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    if (process.platform !== "win32") {
      try { process.kill(-pid); } catch { try { process.kill(pid); } catch {} }
      resolve();
      return;
    }
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 }, () => resolve());
  });
}
