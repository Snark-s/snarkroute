import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { bridgeConfigPath } from "./snarkbridge-policy";

/**
 * P-04: the owner puts site passwords into the SnarkBridge vault from the Workshop. The value goes
 * to the bridge CLI on stdin only (never argv, never logs, never a response); the vault encrypts it
 * with Windows DPAPI and agents can only type it into a field of a site it is bound to.
 */
export type BridgeSecretView = { ref: string; origins: string[]; updated?: string };

const REF = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type VaultRunner = (args: string[], stdin?: string) => Promise<string>;

export function vaultRunner(configPath = bridgeConfigPath()): VaultRunner {
  const home = dirname(configPath);
  const python = join(home, ".venv", "Scripts", "python.exe");
  return (args, stdin) => new Promise((resolve, reject) => {
    if (!existsSync(python)) return reject(new Error("Не найден Python моста SnarkBridge."));
    const child = spawn(python, [join(home, "bridge_vault.py"), ...args], {
      cwd: home, windowsHide: true,
      env: { ...process.env, SNARKBRIDGE_CONFIG: configPath, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
    });
    let out = ""; let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Хранилище паролей не ответило вовремя.")); }, 20_000);
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      // stderr of the CLI never contains the value; keep only the last line (the error message).
      reject(new Error(err.trim().split(/\r?\n/).pop() || `bridge_vault завершился с кодом ${code}`));
    });
    child.stdin.end(stdin ?? "", "utf8");
  });
}

export function normalizeOrigins(origins: unknown): string[] {
  const list = Array.isArray(origins) ? origins : typeof origins === "string" ? origins.split(/[\s,]+/) : [];
  const result = list.map(value => String(value).trim()).filter(Boolean).map(value => {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "https:") throw new Error("Пароль можно привязать только к https-сайту.");
    return url.origin;
  });
  if (!result.length) throw new Error("Укажи хотя бы один сайт.");
  return [...new Set(result)];
}

export async function listBridgeSecrets(run: VaultRunner = vaultRunner()): Promise<BridgeSecretView[]> {
  const parsed = JSON.parse((await run(["list"])) || "[]");
  return (Array.isArray(parsed) ? parsed : []).map((item: any) => ({ ref: String(item.ref), origins: (item.origins ?? []).map(String), updated: item.updated }));
}

export async function setBridgeSecret(body: { ref?: unknown; origins?: unknown; value?: unknown }, run: VaultRunner = vaultRunner()) {
  const ref = String(body.ref ?? "").trim();
  if (!REF.test(ref)) throw new Error("Имя пароля: латиница в нижнем регистре, цифры, точка, дефис (до 64 символов).");
  const value = typeof body.value === "string" ? body.value : "";
  if (!value || /[\r\n]/.test(value)) throw new Error("Пароль пустой или содержит перевод строки.");
  const origins = normalizeOrigins(body.origins);
  await run(["set", ref, JSON.stringify(origins)], value);
  return { ref, origins };
}

export async function deleteBridgeSecret(ref: string, run: VaultRunner = vaultRunner()) {
  if (!REF.test(ref)) throw new Error("Неверное имя пароля.");
  await run(["delete", ref]);
  return { ref, deleted: true };
}
