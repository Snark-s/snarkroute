/*
 * Windowless background launch for long-lived local services.
 *
 * Why a separate short-lived process: on Windows, Node's `detached: true` gives the child
 * DETACHED_PROCESS (no console at all), so every console grandchild it starts (cmd -> pnpm,
 * venv python.exe -> python, npm, runners) opens its own visible terminal window. Without
 * `detached`, libuv puts the child into a kill-on-close job, so the service would die with
 * SnarkRoute. This shim is spawned without `detached` and with no inherited handles, which
 * gives it a hidden console (CREATE_NO_WINDOW). It opens the log file itself (shared,
 * append-only, so the log can be rotated while the service runs) and starts the service
 * through cmd.exe: cmd stays in the job, the service is a grandchild outside it, inherits the
 * hidden console and the log handle, and keeps running after the shim and SnarkRoute exit.
 *
 * Usage: node windowless-launch.mjs <base64url JSON {label, command, args, cwd, log}>
 * Prints one JSON line: {ok, pid?, trampolinePid?, exitedEarly?, exitCode?, log}.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOG_MAX_BYTES = 8 * 1024 * 1024;
export const LOG_KEEP = 3;

export function rotatedLogPath(path, generation) {
  return /\.log$/i.test(path) ? path.replace(/\.log$/i, `.${generation}.log`) : `${path}.${generation}`;
}

/** Shift foo.log -> foo.1.log -> foo.2.log ... before a new launch appends to it. */
export function rotateLogIfLarge(path, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP) {
  try {
    if (!existsSync(path) || statSync(path).size < maxBytes) return false;
    rmSync(rotatedLogPath(path, keep), { force: true });
    for (let generation = keep - 1; generation >= 1; generation--) {
      const from = rotatedLogPath(path, generation);
      if (existsSync(from)) renameSync(from, rotatedLogPath(path, generation + 1));
    }
    renameSync(path, rotatedLogPath(path, 1));
    return true;
  } catch {
    return false; // a previous instance may still hold the file; the live trimmer handles it later
  }
}

/** Windows CRT quoting; cmd.exe treats & | < > ^ ( ) literally inside the quotes. */
export function quoteWindowsArg(value) {
  const text = String(value);
  if (/["%\r\n]/.test(text)) throw new Error(`Unsafe character in background launch argument: ${text.slice(0, 80)}`);
  if (text && !/[\s&|<>^()]/.test(text)) return text;
  let out = '"';
  let slashes = 0;
  for (const char of text) {
    if (char === '\\') { slashes++; continue; }
    out += '\\'.repeat(slashes) + char;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

export function trampolineCommandLine(command, args = []) {
  return [command, ...args].map(quoteWindowsArg).join(' ');
}

export function encodeLaunchSpec(spec) {
  return Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url');
}

/** In-process client: runs this file as the shim and resolves with its JSON report. */
export function launchWindowless(spec, { env = process.env, timeoutMs = 20_000 } = {}) {
  const self = fileURLToPath(import.meta.url);
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(process.execPath, [self, encodeLaunchSpec(spec)], {
      cwd: spec.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); rejectLaunch(new Error(`Background launch of ${spec.label} timed out`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); rejectLaunch(error); });
    child.once('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).pop();
      try {
        const report = JSON.parse(line);
        if (report.ok) resolveLaunch(report); else rejectLaunch(new Error(report.error || `Background launch of ${spec.label} failed`));
      } catch {
        rejectLaunch(new Error(`Background launch of ${spec.label} failed: ${(stderr || stdout).trim().slice(-600)}`));
      }
    });
  });
}

function childProcessesOf(parentPid) {
  return new Promise((resolveList) => {
    const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(parentPid)}' | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.Name }`;
    const query = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    query.stdout.on('data', (chunk) => { output += chunk; });
    query.once('error', () => resolveList([]));
    query.once('close', () => resolveList(output.split(/\r?\n/).map((line) => {
      const [pid, ...name] = line.trim().split(' ');
      return { pid: Number(pid), name: name.join(' ').toLowerCase() };
    }).filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0 && entry.name !== 'conhost.exe')));
  });
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function main() {
  const spec = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8'));
  const report = (value) => { process.stdout.write(`${JSON.stringify({ log: spec.log, ...value })}\n`); };
  if (!spec.command || !spec.log || !spec.cwd) { report({ ok: false, error: 'command, cwd and log are required' }); return; }

  mkdirSync(dirname(spec.log), { recursive: true });
  rotateLogIfLarge(spec.log);
  const fd = openSync(spec.log, 'a');
  writeSync(fd, `\n[${new Date().toISOString()}] ▶ ${spec.label ?? spec.command}: фоновый запуск без окна (SnarkRoute)\n`);

  let child;
  if (process.platform === 'win32') {
    const line = trampolineCommandLine(spec.command, spec.args ?? []);
    child = spawn('cmd.exe', ['/d', '/s', '/v:off', '/c', `"${line}"`], {
      cwd: spec.cwd, env: process.env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', fd, fd]
    });
  } else {
    child = spawn(spec.command, spec.args ?? [], { cwd: spec.cwd, env: process.env, detached: true, stdio: ['ignore', fd, fd] });
  }
  closeSync(fd);

  let exitCode;
  const exited = new Promise((resolveExit) => child.once('exit', (code) => { exitCode = code; resolveExit(); }));
  try {
    await new Promise((resolveSpawn, rejectSpawn) => { child.once('spawn', resolveSpawn); child.once('error', rejectSpawn); });
  } catch (error) {
    report({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  let pid = process.platform === 'win32' ? undefined : child.pid;
  if (process.platform === 'win32') {
    for (let attempt = 0; attempt < 6 && pid === undefined; attempt++) {
      await Promise.race([delay(attempt === 0 ? 250 : 400), exited]);
      const children = await childProcessesOf(child.pid);
      pid = children[0]?.pid;
      if (pid === undefined && exitCode !== undefined) break;
    }
  } else {
    child.unref();
  }

  const exitedEarly = pid === undefined && exitCode !== undefined;
  try {
    writeFileSync(`${spec.log}.launch.json`, JSON.stringify({
      label: spec.label, pid, trampolinePid: child.pid, startedAt: new Date().toISOString()
    }), 'utf8');
  } catch {}
  report({ ok: true, pid, trampolinePid: child.pid, ...(exitedEarly ? { exitedEarly: true, exitCode } : {}) });
  // Exiting closes this shim's job and ends cmd.exe only; the service keeps running.
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  });
}
