import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

// Optional companion: failure must not prevent SnarkRoute from starting.
export async function ensurePersonaBridge({
  env = process.env, platform = process.platform, exists = existsSync,
  probe = portOpen, launch = spawn, log = console,
} = {}) {
  if (env.PERSONA_BRIDGE_AUTO_START === "0") return;
  const port = 8766;
  try {
    if (await probe(port)) return;
    const home = [env.PERSONA_HOME, platform === "win32" ? "I:\\PersonaCore" : undefined,
      env.USERPROFILE ? join(env.USERPROFILE, "PersonaCore") : undefined]
      .find((candidate) => candidate && exists(join(candidate, "scripts", "start_extension_bridge.py")));
    if (!home) return;
    const python = env.PERSONA_PYTHON ?? join(home, ".venv", platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");
    if (!exists(python)) { log.warn("Persona Bridge: Python not found; set PERSONA_PYTHON."); return; }
    const child = launch(python, [join(home, "scripts", "start_extension_bridge.py"), "--port", String(port)], {
      cwd: home, env: { ...env, PERSONA_HOME: home, PYTHONUTF8: "1" },
      detached: true, windowsHide: true, stdio: "ignore", shell: false,
    });
    child.once("error", () => log.warn("Persona Bridge: could not start."));
    child.unref();
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await probe(port)) { log.log("Persona Bridge: http://127.0.0.1:8766"); return; }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    log.warn("Persona Bridge did not become ready; SnarkRoute will continue starting.");
  } catch {
    log.warn("Persona Bridge unavailable; SnarkRoute will continue starting.");
  }
}
