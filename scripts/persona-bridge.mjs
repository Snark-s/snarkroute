import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { registeredPort, resolveServiceHome, serviceHealthy } from "./local-service-registry.mjs";

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

const pendingStarts = new Map();

// Optional companion: failure must not prevent SnarkRoute from starting.
export async function ensurePersonaBridge({
  env = process.env, platform = process.platform, exists = existsSync,
  probe = portOpen, launch = spawn, log = console,
  healthy = () => serviceHealthy('persona_bridge', { env }),
  starts = pendingStarts, delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (env.PERSONA_BRIDGE_AUTO_START === "0") return true;
  const port = registeredPort('persona_bridge', 'PERSONA_BRIDGE_PORT', env);
  try {
    if (await probe(port)) {
      if (await healthy()) { starts.delete(port); return true; }
      log.warn('Persona Bridge: occupied port failed service identity/API version check.');
      return false;
    }
    const pending = starts.get(port);
    if (pending && pending.exitCode == null) {
      log.warn('Persona Bridge: owned process is still initializing; no duplicate will be launched.');
      return false;
    }
    starts.delete(port);
    const home = [env.PERSONA_HOME, resolveServiceHome('personacore', env),
      env.USERPROFILE ? join(env.USERPROFILE, "PersonaCore") : undefined]
      .find((candidate) => candidate && exists(join(candidate, "scripts", "start_extension_bridge.py")));
    if (!home) return false;
    const configuredPython = env.PERSONA_PYTHON?.trim();
    const consolePython = join(home, ".venv", platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");
    const windowlessPython = platform === "win32" ? join(home, ".venv", "Scripts", "pythonw.exe") : undefined;
    const python = configuredPython || (windowlessPython && exists(windowlessPython) ? windowlessPython : consolePython);
    if (!exists(python)) { log.warn("Persona Bridge: Python not found; set PERSONA_PYTHON."); return false; }
    const child = launch(python, [join(home, "scripts", "start_extension_bridge.py"), "--port", String(port)], {
      cwd: home, env: { ...env, PERSONA_HOME: home, PYTHONUTF8: "1", SNARKROUTE_HOME: resolveServiceHome('snarkroute', env) },
      detached: true, windowsHide: true, stdio: "ignore", shell: false,
    });
    starts.set(port, child);
    child.once("error", () => log.warn("Persona Bridge: could not start."));
    child.once('exit', () => { if (starts.get(port) === child) starts.delete(port); });
    child.unref();
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await probe(port) && await healthy()) { starts.delete(port); log.log(`Persona Bridge: http://127.0.0.1:${port}`); return true; }
      await delay(300);
    }
    log.warn("Persona Bridge did not become ready; SnarkRoute will continue starting.");
  } catch {
    log.warn("Persona Bridge unavailable; SnarkRoute will continue starting.");
  }
  return false;
}

// Keep the optional bridge available after the one-shot launcher has opened the UI.
// A serialized check prevents duplicate bridge processes when startup is slow.
export function startPersonaBridgeSupervisor({
  ensure = ensurePersonaBridge,
  intervalMs = 10_000,
  schedule = setInterval,
  maxFailures = 3,
  log = console,
} = {}) {
  let checking = false;
  let failures = 0;
  const check = async () => {
    if (checking || failures >= maxFailures) return;
    checking = true;
    try {
      if (await ensure() === false) failures++; else failures = 0;
    } catch {
      failures++;
    } finally {
      checking = false;
      if (failures >= maxFailures) log.warn('Persona Bridge: automatic starts paused after repeated failures; restart the launcher after correcting configuration.');
    }
  };
  return schedule(check, intervalMs);
}
