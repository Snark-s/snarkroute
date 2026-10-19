import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rotateLogIfLarge } from './windowless-launch.mjs';

/** The venv python.exe is a launcher whose child serves the port: stop the whole tree. */
export function killProcessTree(child) {
  if (process.platform !== 'win32' || !child.pid) return child.kill();
  execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => {});
  return true;
}

const probePort = (port) =>
  new Promise((resolveProbe) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      resolveProbe(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });

export function projectPublisherLaunchSpec(root, port) {
  const python = process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python');

  return {
    python,
    args: [
      '-m',
      'project_publisher.cli',
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    cwd: root,
  };
}

export function createProjectPublisherControl({
  root,
  port = 8765,
  spawnProcess = spawn,
  killTree = killProcessTree,
  /** When set, stdout/stderr go to this rotating log (shown in the Мастерская terminals). */
  logPath,
  fileExists = existsSync,
  portOpen = () => probePort(port),
  healthy = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  },
  timeoutMs = 60_000,
  pollMs = 300,
  wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
  now = Date.now,
} = {}) {
  root = resolve(root);
  const launch = projectPublisherLaunchSpec(root, port);
  let child;
  let exited;
  let inflight;
  let operation = null;

  const until = async (predicate, message) => {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (await predicate()) return;
      await wait(pollMs);
    }
    throw new Error(message);
  };

  const status = async () => {
    const running = await portOpen();
    const managed = Boolean(child);
    return {
      service: 'project-publisher-control',
      port,
      url: `http://127.0.0.1:${port}`,
      root,
      available: fileExists(launch.python),
      running,
      healthy: running ? await healthy() : false,
      managed,
      external: running && !managed,
      pid: child?.pid,
      operation: operation ? { ...operation } : null,
    };
  };

  const stopOwned = async () => {
    if (!child) {
      if (await portOpen()) {
        throw new Error('Порт Project Publisher занят процессом вне Мастерской');
      }
      return;
    }

    const current = child;
    killTree(current);
    await until(
      async () => !child || !(await portOpen()),
      'Project Publisher не остановился вовремя'
    );
    await exited?.catch(() => {});
  };

  const startOwned = async () => {
    if (await portOpen()) {
      if (child && await healthy()) return;
      throw new Error('Порт Project Publisher уже занят; запуск отменён');
    }
    if (!fileExists(launch.python)) {
      throw new Error(`Python Project Publisher не найден: ${launch.python}`);
    }

    let log;
    if (logPath) {
      mkdirSync(dirname(logPath), { recursive: true });
      rotateLogIfLarge(logPath);
      log = openSync(logPath, 'a');
      writeSync(log, `\n[${new Date().toISOString()}] ▶ Project Publisher: запуск из Мастерской\n`);
    }
    let current;
    try {
      current = spawnProcess(launch.python, launch.args, {
        cwd: launch.cwd,
        // Live log lines and readable Cyrillic when output goes to a file.
        env: log === undefined ? process.env : { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
        detached: false,
        stdio: ['ignore', log ?? 'inherit', log ?? 'inherit'],
      });
    } finally {
      if (log !== undefined) closeSync(log);
    }
    child = current;
    if (logPath) {
      try {
        writeFileSync(`${logPath}.launch.json`, JSON.stringify({ label: 'Project Publisher', pid: current.pid, startedAt: new Date().toISOString() }), 'utf8');
      } catch {}
    }
    exited = new Promise((resolveExit) => {
      current.once('close', () => {
        if (child === current) child = undefined;
        resolveExit();
      });
    });
    await new Promise((resolveSpawn, rejectSpawn) => {
      current.once('spawn', resolveSpawn);
      current.once('error', rejectSpawn);
    });
    await until(
      async () => Boolean(child) && await healthy(),
      'Project Publisher не запустился вовремя'
    );
  };

  const perform = async (action) => {
    if (inflight) throw new Error('Другая операция Project Publisher ещё выполняется');
    operation = {
      id: randomUUID(),
      action,
      state: action === 'stop' ? 'stopping' : 'starting',
      startedAt: new Date().toISOString(),
    };
    inflight = Promise.resolve().then(async () => {
      if (action === 'stop') {
        await stopOwned();
        operation.state = 'stopped';
      } else if (action === 'restart') {
        await stopOwned();
        operation.state = 'starting';
        await startOwned();
        operation.state = 'running';
      } else {
        await startOwned();
        operation.state = 'running';
      }
      operation.finishedAt = new Date().toISOString();
    }).catch((error) => {
      operation.state = 'error';
      operation.error = error instanceof Error ? error.message : String(error);
      operation.finishedAt = new Date().toISOString();
      throw error;
    }).finally(() => {
      inflight = undefined;
    });
    await inflight;
    return status();
  };

  return {
    status,
    start: () => perform('start'),
    stop: () => perform('stop'),
    restart: () => perform('restart'),
    shutdown: async () => {
      await inflight?.catch(() => {});
      if (child) await perform('stop').catch(() => {});
    },
  };
}

export function defaultProjectPublisherRoot(snarkRouteRoot = process.cwd()) {
  return resolve(
    process.env.PROJECT_PUBLISHER_DIR ||
      join(snarkRouteRoot, '..', '..', 'Приложения', 'Project Publisher')
  );
}
