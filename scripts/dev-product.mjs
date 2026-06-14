#!/usr/bin/env node
import { spawn } from "node:child_process";

const product = process.argv[2] ?? "boojum";
const flags = new Set(process.argv.slice(3));
const cloud = flags.has("--cloud");

const env = { ...process.env };
const args = ["pnpm", "-r", "--parallel"];

if (product === "snarkroute") {
  args.push("--stream", "--filter", "@snarkroute/server", "--filter", "@snarkroute/snarkroute", "run", "dev");
} else if (product === "boojum") {
  args.push("--filter", "@snarkroute/server", "--filter", "@snarkroute/studio", "run", "dev");
  if (cloud) {
    env.APP_PRODUCT ??= "boojum";
    env.APP_MODE ??= "cloud";
    env.APP_DEV_UI ??= "true";
    env.DATABASE_URL ??= "postgresql://snarkroute:snarkroute@127.0.0.1:5432/snarkroute";
    env.DEV_USER_ID ??= "00000000-0000-4000-8000-000000000001";
  }
} else {
  console.error(`Unknown product: ${product}`);
  process.exit(1);
}

const child = spawn("corepack", args, { env, stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
