#!/usr/bin/env node
import { spawn } from "node:child_process";

const product = process.argv[2] ?? "boojum";
const flags = new Set(process.argv.slice(3));
const cloud = flags.has("--cloud");
const autoOpen = !flags.has("--no-open") && process.env.SNARKROUTE_AUTO_OPEN !== "0";

const env = { ...process.env };
const args = ["pnpm", "-r", "--parallel"];
let appUrl;

if (product === "snarkroute") {
  const port = Number(env.SNARKROUTE_PORT ?? 5174);
  appUrl = `http://127.0.0.1:${port}`;
  args.push("--stream", "--filter", "@snarkroute/server", "--filter", "@snarkroute/snarkroute", "run", "dev");
} else if (product === "boojum") {
  const port = Number(env.STUDIO_PORT ?? 5173);
  appUrl = `http://127.0.0.1:${port}`;
  args.push("--filter", "@snarkroute/server", "--filter", "@snarkroute/studio", "run", "dev");
  if (cloud) {
    env.APP_PRODUCT ??= "boojum";
    env.APP_MODE ??= "cloud";
    env.APP_DEV_UI ??= "true";
    env.DATABASE_URL ??= "postgresql://snarkroute:snarkroute@127.0.0.1:5432/snarkroute";
    env.DEV_USER_ID ??= "00000000-0000-4000-8000-000000000001";
  }
} else if (product === "brandeshmyg") {
  const port = Number(env.BRANDESHMYG_PORT ?? 5175);
  appUrl = `http://127.0.0.1:${port}`;
  args.push("--stream", "--filter", "@snarkroute/server", "--filter", "@snarkroute/brandeshmyg", "run", "dev");
} else {
  console.error(`Unknown product: ${product}`);
  process.exit(1);
}

async function waitForUrl(url, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.status >= 200 && response.status < 500) return true;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function openUrl(url) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const opener = spawn(command, args, { detached: true, stdio: "ignore" });
  opener.unref();
}

async function openWhenReady(url) {
  if (!await waitForUrl(url)) {
    console.warn(`Timed out waiting for ${url}; leaving dev processes running.`);
    return;
  }
  console.log(`Opening ${url}`);
  openUrl(url);
}

const child = spawn("corepack", args, { env, stdio: "inherit", shell: process.platform === "win32" });
if (autoOpen && appUrl) void openWhenReady(appUrl);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
