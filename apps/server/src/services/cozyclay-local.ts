import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localServiceHome, localServicePort } from "./local-service-endpoints";

/**
 * Drives CozyClay's *already running* Studio live hub through its documented CLI.
 * This is a local scene tool, NOT a model provider. Models/video go via SnarkRoute.
 * Never start a second CozyClay MCP hub beside a running Studio.
 */
const cozyClayHome = () => {
  const home = localServiceHome("cozyclay");
  if (!home) throw new Error("CozyClay is not registered in service-endpoints.json");
  return home;
};
const cliLocation = () => {
  const root = cozyClayHome();
  const upgraded = join(root, "upgrade-3.1.3");
  const candidate = join(upgraded, "node_modules", "cozyclay", "bin", "cozyclay.mjs");
  return existsSync(candidate) ? { home: upgraded, binary: candidate }
    : { home: root, binary: join(root, "node_modules", "cozyclay", "bin", "cozyclay.mjs") };
};

export type CozyClayCli = (args: string[], timeoutMs?: number) => Promise<unknown>;

export const runCozyClayCli: CozyClayCli = async (args, timeoutMs = 15000) => {
  const { binary, home } = cliLocation();
  if (!existsSync(binary)) throw new Error(
    "CozyClay is not installed in Y:\\Приложения\\CozyClay. Run УСТАНОВИТЬ.cmd there first."
  );
  // Execute the verified local JS entry with argv, not a shell: paths and input stay inert.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: home, windowsHide: true, env: { ...process.env, COZYCLAY_LIVE_PORT: String(localServicePort("cozyclay_live")), COZYCLAY_TELEMETRY: "0", DO_NOT_TRACK: "1" }
    });
    let stdout = "", stderr = "";
    let overflow = false;
    const limit = 2 * 1024 * 1024;
    const collect = (stream: "out" | "err", data: Buffer) => {
      const chunk = data.toString("utf8");
      if ((stream === "out" ? stdout.length : stderr.length) + chunk.length > limit) {
        overflow = true;
        child.kill();
      } else if (stream === "out") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", data => collect("out", data));
    child.stderr.on("data", data => collect("err", data));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (overflow) return reject(new Error("CozyClay output exceeded safety limit"));
      let payload: unknown;
      try { payload = JSON.parse(stdout.trim()); }
      catch { payload = { stdout: stdout.slice(-5000) }; }
      if (code !== 0) return reject(new Error(
        `CozyClay CLI exit ${code}: ${JSON.stringify(payload).slice(0, 5000)} ${stderr.slice(-300)}`
      ));
      resolve(payload);
    });
  });
};

export async function withCozyClayOpsFile<T>(
  ops: unknown, callback: (path: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "snarkroute-cozyclay-"));
  const path = join(directory, "ops.json");
  try {
    await writeFile(path, JSON.stringify(ops), { encoding: "utf8", flag: "wx" });
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
