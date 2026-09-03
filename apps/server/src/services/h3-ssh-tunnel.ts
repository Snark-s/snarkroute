import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createConnection, createServer } from "node:net";
import { h3StudioDirectory } from "../server-paths";

export type H3SshTunnel = {
  workerUrl: string;
  localPort: number;
  close: () => Promise<void>;
};

export function resolveH3SshPrivateKeyPath(configured = process.env.H3_VAST_SSH_PRIVATE_KEY?.trim() ?? ""): string {
  const candidates = configured
    ? [expandHome(configured)]
    : [join(homedir(), ".ssh", "id_ed25519"), join(homedir(), ".ssh", "id_rsa")];
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

export async function openH3SshTunnel(options: {
  instanceId: number;
  host: string;
  port: number;
  privateKeyPath?: string;
  remotePort?: number;
  timeoutMs?: number;
}): Promise<H3SshTunnel> {
  const privateKeyPath = resolveH3SshPrivateKeyPath(options.privateKeyPath);
  if (!privateKeyPath) throw new Error("No SSH private key was found. Configure H3_VAST_SSH_PRIVATE_KEY or create ~/.ssh/id_ed25519.");
  if (!options.host.trim()) throw new Error("Vast did not provide an SSH host for the H3 instance.");
  if (!Number.isSafeInteger(options.port) || options.port <= 0) throw new Error("Vast did not provide a valid SSH port for the H3 instance.");

  const localPort = await availablePort();
  const knownHostsDirectory = join(h3StudioDirectory, "ssh");
  await mkdir(knownHostsDirectory, { recursive: true });
  const knownHostsPath = join(knownHostsDirectory, `known-hosts-${options.instanceId}`);
  const sshBinary = process.env.H3_SSH_BINARY?.trim() || "ssh";
  const remotePort = options.remotePort ?? 18_080;
  const child = spawn(sshBinary, [
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=25",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHostsPath}`,
    "-i", privateKeyPath,
    "-p", String(options.port),
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    `root@${options.host.trim()}`
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000); });
  try {
    await waitForTunnel(child, localPort, options.timeoutMs ?? 90_000, () => stderr);
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  return {
    workerUrl: `http://127.0.0.1:${localPort}`,
    localPort,
    close: () => stopChild(child)
  };
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForTunnel(child: ChildProcess, port: number, timeoutMs: number, stderr: () => string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`SSH tunnel exited before it became ready${stderr().trim() ? `: ${stderr().trim()}` : "."}`);
    if (await canConnect(port)) return;
    await delay(250);
  }
  throw new Error(`SSH tunnel did not open within ${Math.ceil(timeoutMs / 1_000)} seconds${stderr().trim() ? `: ${stderr().trim()}` : "."}`);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolveConnection(true); });
    socket.once("timeout", () => { socket.destroy(); resolveConnection(false); });
    socket.once("error", () => resolveConnection(false));
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 2_000);
    child.once("exit", () => { clearTimeout(timeout); resolveStop(); });
    child.kill("SIGTERM");
  });
}

function expandHome(value: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") || value.startsWith("~\\") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
