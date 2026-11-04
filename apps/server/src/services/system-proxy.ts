import { execFileSync } from "node:child_process";

/**
 * The Windows system proxy (Internet Settings) as environment variables for CLIs that ignore it.
 * The Codex CLI talks to chatgpt.com directly; on this computer that only works through the owner's
 * proxy client, which Windows apps pick up from Internet Settings and command-line tools do not.
 */
export function parseWindowsProxy(enabled: boolean, server: string | undefined): Record<string, string> {
  if (!enabled || !server?.trim()) return {};
  const parts = Object.fromEntries(server.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const [key, value] = part.includes("=") ? part.split("=", 2) : ["all", part];
    return [key.toLowerCase(), value];
  }));
  const socks = parts.socks;
  const http = parts.https ?? parts.http ?? parts.all;
  const url = socks ? `socks5h://${socks.replace(/^socks5?h?:\/\//i, "")}` : http ? (/^\w+:\/\//.test(http) ? http : `http://${http}`) : undefined;
  if (!url) return {};
  return { HTTPS_PROXY: url, HTTP_PROXY: url, ALL_PROXY: url, NO_PROXY: "localhost,127.0.0.1,::1" };
}

let cache: { at: number; env: Record<string, string> } | undefined;
export function systemProxyEnv(now = Date.now()): Record<string, string> {
  // Unit tests must not depend on the proxy of the computer they happen to run on.
  if (process.platform !== "win32" || process.env.SNARKROUTE_SYSTEM_PROXY === "0" || process.env.VITEST && process.env.SNARKROUTE_SYSTEM_PROXY !== "1") return {};
  if (cache && now - cache.at < 60_000) return cache.env;
  let env: Record<string, string> = {};
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    const value = (name: string) => out.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "mi"))?.[1]?.trim();
    env = parseWindowsProxy(/^0x0*1$/i.test(value("ProxyEnable") ?? ""), value("ProxyServer"));
  } catch { env = {}; }
  cache = { at: now, env };
  return env;
}

/** Proxy variables the owner set explicitly win; otherwise the system proxy fills the gap. */
export function withSystemProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const explicit = Object.keys(env).some(key => ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"].includes(key.toUpperCase()));
  return explicit ? env : { ...env, ...systemProxyEnv() };
}
