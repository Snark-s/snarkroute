#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { ensurePersonaBridge, startPersonaBridgeSupervisor } from "./persona-bridge.mjs";
import { startLauncherControl } from "./launcher-control.mjs";
import { createProjectPublisherControl, defaultProjectPublisherRoot } from "./project-publisher-control.mjs";
import { registeredPort, serviceHealthy } from "./local-service-registry.mjs";

try { process.loadEnvFile(join(process.cwd(), ".env")); } catch (error) { if (error.code !== "ENOENT") throw error; }

await ensurePersonaBridge();
if (process.env.PERSONA_BRIDGE_AUTO_START !== "0") startPersonaBridgeSupervisor();

const apiPort = registeredPort('snarkroute', 'API_PORT');
const launcherPort = registeredPort('launcher', 'LAUNCHER_PORT');
const apiUrl = `http://127.0.0.1:${apiPort}/api/health`;
const launcherUrl = `http://127.0.0.1:${launcherPort}`;
const controlPort = registeredPort('launcher_control', 'SNARKROUTE_LAUNCHER_CONTROL_PORT');
const projectPublisher = createProjectPublisherControl({
  root: defaultProjectPublisherRoot(process.cwd()),
  port: registeredPort('project_publisher', 'PROJECT_PUBLISHER_PORT')
});

const owner = await startLauncherControl({ apiPort, controlPort, projectPublisher });
if (!owner.existing) {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return; shuttingDown = true;
    void owner.close().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exitCode = 1; });
  };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}
if (!owner.existing && !await portOpen(apiPort)) {
  await runPackageBuild("@snarkroute/server...", { API_PORT: String(apiPort) });
  await owner.control.initialize();
}
if (!await portOpen(launcherPort)) {
  await runPackageBuild("@snarkroute/launcher", { LAUNCHER_PORT: String(launcherPort), VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}`, VITE_LAUNCHER_CONTROL_PORT: String(controlPort) });
  startPackage("@snarkroute/launcher", "preview", { LAUNCHER_PORT: String(launcherPort), VITE_API_BASE_URL: `http://127.0.0.1:${apiPort}`, VITE_LAUNCHER_CONTROL_PORT: String(controlPort) }, ["--host", "127.0.0.1", "--port", String(launcherPort), "--strictPort"]);
}

const [apiReady, launcherReady] = await Promise.all([waitForUrl(apiUrl, 'snarkroute'), waitForUrl(launcherUrl)]);
if (!apiReady || !launcherReady) {
  console.error(`Не удалось запустить мастерскую. Проверьте сервисы и порты ${apiPort} и ${launcherPort}.`);
  process.exitCode = 1;
} else {
  if (!process.argv.includes("--no-browser")) openUrl(launcherUrl);
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

async function waitForUrl(url, service, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (service) { if (await serviceHealthy(service)) return true; }
      else {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1200) });
        if (response.status === 200 && (await response.text()).includes('<title>Мастерская</title>')) return true;
      }
    } catch { /* starting */ }
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
