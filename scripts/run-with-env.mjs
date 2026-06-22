#!/usr/bin/env node
import { spawn } from "node:child_process";

const separator = process.argv.indexOf("--");
if (separator < 0) {
  console.error("Usage: node scripts/run-with-env.mjs KEY=value [KEY=value...] -- command [args...]");
  process.exit(1);
}

const env = { ...process.env };
for (const assignment of process.argv.slice(2, separator)) {
  const equals = assignment.indexOf("=");
  if (equals <= 0) {
    console.error(`Invalid environment assignment: ${assignment}`);
    process.exit(1);
  }
  env[assignment.slice(0, equals)] = assignment.slice(equals + 1);
}

const [command, ...args] = process.argv.slice(separator + 1);
if (!command) {
  console.error("Missing command after --");
  process.exit(1);
}

const child = spawn(command, args, { env, stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
