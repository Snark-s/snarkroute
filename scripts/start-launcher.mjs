#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { ensurePersonaBridge } from "./persona-bridge.mjs";

await ensurePersonaBridge();

const apiPort = Number(process.env.API_PORT ?? 4317);
const launcherPort = Number(process.env.LAUNCHER_PORT ?? 5172);
const apiUrl = `http://127.0.0.1:${apiPort}/api/health`;
const launcherUrl = `http://127.0.0.1:${launcherPort}`;

if (!await portOpen(apiPort)) {
  await runPackageBuild("@snarkroute/server...", { API_PORT: String(apiPort) });
  startPackage("@snarkroute/server", "start", { API_PORT: String(apiPort) });
}
if (!await portOpen(launcherPort)) {
  await runPackageBuild("@snarkroute/launcher", { LAUNCHER_PORT: String(launcherPort), VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}` });
  startPackage("@snarkroute/launcher", "preview", { LAUNCHER_PORT: String(launcherPort), VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}` }, ["--host", "127.0.0.1", "--port", String(launcherPort), "--strictPort"]);
}

const [apiReady, launcherReady] = await Promise.all([waitForUrl(apiUrl), waitForUrl(launcherUrl)]);
if (!apiReady || !launcherReady) {
  console.error("Не удалось запустить мастерскую. Проверьте, не заняты ли порты 4317 и 5172.");
  process.exitCode = 1;
} else {
  openUrl(launcherUrl);
}

function startPackage(packageName, script, extraEnv, scriptArgs = []) {
  const child = spawn("corepack", ["pnpm", "--filter", packageName, script, ...scriptArgs], {
    cwd: process.cwd(), detached: true, shell: process.platform === "win32", stdio: "ignore", windowsHide: true,
    env: { ...process.env, ...extraEnv }
  });
  child.unref();
}

function runPackageBuild(packageName, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn("corepack", ["pnpm", "--filter", packageName, "build"], {
      cwd: process.cwd(), shell: process.platform === "win32", stdio: "ignore", windowsHide: true,
      env: { ...process.env, ...extraEnv }
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Build failed for ${packageName} (exit ${code}).`)));
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

async function waitForUrl(url, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1200) })).status < 500) return true; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

function openUrl(url) {
  if (process.platform === "win32") {
    const chrome = [
      process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    ].find((candidate) => candidate && existsSync(candidate));
    if (chrome) {
      const child = spawn(chrome, [url], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      return;
    }
  }
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
