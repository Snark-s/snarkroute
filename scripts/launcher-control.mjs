import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registeredPort } from './local-service-registry.mjs';
import { rotateLogIfLarge } from './windowless-launch.mjs';

function readEnvFile(path) {
  try { return parseEnv(readFileSync(path, 'utf8')); } catch { return {}; }
}

/**
 * Values of the repo .env that changed since the launcher started. The launcher loads .env once at start and
 * hands its environment to every server it spawns, so without this an edited .env (e.g. a moved port) needs a
 * full launcher restart. A key is refreshed only while the launcher still holds the value it loaded from the
 * file (or none) — a variable set explicitly in the environment keeps winning.
 */
export function refreshedEnvFileValues(envPath, current, startupValues) {
  const fresh = readEnvFile(envPath);
  const result = {};
  for (const [key, value] of Object.entries(fresh)) {
    if (current[key] === undefined || current[key] === startupValues[key]) result[key] = value;
  }
  return result;
}

/** Console output of the API server for the Мастерская terminal (rotated by the server itself). */
export function serverLogPath(root) {
  return join(root, 'apps', 'server', 'data', 'logs', 'snarkroute-server.log');
}

export function allowedControlOrigin(origin) {
  if (!origin) return true;

  try {
    const u = new URL(origin);

    return (
      (u.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) ||
      (u.protocol === 'chrome-extension:' &&
        /^[a-p]{32}$/.test(u.hostname))
    );
  } catch {
    return false;
  }
}

export function serverLaunchSpec(root, apiPort, token) {
  const loaderUrl = pathToFileURL(
    join(root, 'apps/server/node_modules/tsx/dist/loader.mjs')
  ).href;

  return {
    packageName: '@snarkroute/server',
    script: 'start',
    command: process.execPath,
    args: ['--import', loaderUrl, 'src/index.ts'],
    cwd: join(root, 'apps/server'),
    env: {
      ...process.env,
      API_PORT: String(apiPort),
      PERSONA_BRIDGE_AUTO_START: '0',
      SNARKROUTE_LAUNCHER_TOKEN: token,
    },
  };
}

export function createLauncherRestartControl({
  apiPort,
  owned,
  serverPid,
  start,
  stop,
  cleanup,
  portOpen,
  healthy,
  timeoutMs = 60_000,
  portTimeoutMs = Math.min(timeoutMs, 20_000),
  pollMs = 300,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  let operation = null;
  let inflight;

  const until = async (predicate, message, waitTimeoutMs = timeoutMs) => {
    const deadline = now() + waitTimeoutMs;

    while (now() < deadline) {
      if (await predicate()) return;
      await wait(pollMs);
    }

    throw new Error(message);
  };

  const status = () => ({
    service: 'snarkroute-launcher-control',
    packageName: '@snarkroute/server',
    apiPort,
    launcherPid: process.pid,
    managed: owned(),
    serverPid: serverPid(),
    operation: operation ? { ...operation } : null,
  });

  const control = {
    status,

    wait: async () => {
      await inflight;
    },

    shutdown: async () => {
      await inflight?.catch(() => {});

      if (owned()) {
        operation = {
          id: randomUUID(),
          state: 'stopping',
          action: 'shutdown',
        };

        await stop();
      }
    },

    initialize: async () => {
      if (inflight) {
        await inflight;
        return status();
      }

      operation = {
        id: randomUUID(),
        state: 'starting',
        action: 'start',
        startedAt: new Date().toISOString(),
      };

      inflight = Promise.resolve()
        .then(async () => {
          if (await portOpen()) {
            operation = null;
            return;
          }

          await start();

          operation.state = 'waiting_health';

          await until(
            healthy,
            'Server startup health timeout'
          );

          operation.state = 'healthy';
        })
        .catch(async (error) => {
          await cleanup().catch(() => {});

          operation.state = 'error';
          operation.error = String(error);

          throw error;
        })
        .finally(() => {
          inflight = undefined;
        });

      await inflight;

      return status();
    },

    restart: () => {
      if (inflight) return { ...operation };

      if (!owned()) {
        throw new Error(
          'Server is not owned by this launcher. Start SnarkRoute through the managed launcher before restarting.'
        );
      }

      operation = {
        id: randomUUID(),
        state: 'stopping',
        action: 'restart',
        startedAt: new Date().toISOString(),
      };

      let started = false;

      inflight = Promise.resolve()
        .then(async () => {
          await stop();

          operation.state = 'waiting_port';

          await until(
            async () => !(await portOpen()),
            `Server port ${apiPort} did not close within ${portTimeoutMs}ms; replacement was not started`,
            portTimeoutMs
          );

          operation.state = 'starting';

          started = true;

          await start();

          operation.state = 'waiting_health';

          await until(
            healthy,
            'Restarted server health timeout'
          );

          operation.state = 'healthy';
        })
        .catch(async (error) => {
          if (started) {
            await cleanup().catch(() => {});
          }

          operation.state = 'error';
          operation.error =
            error instanceof Error
              ? error.message
              : String(error);
        })
        .finally(() => {
          operation.finishedAt = new Date().toISOString();
          inflight = undefined;
        });

      return { ...operation };
    },

    /**
     * Restart button: after a failed restart the launcher may hold no server while the port is free.
     * Then a fresh start is the only sane action; an occupied port still goes through restart() and is refused.
     */
    restartOrStart: async () => {
      if (!inflight && !owned() && !(await portOpen())) {
        const starting = control.initialize();
        starting.catch(() => {});
        return { ...operation };
      }
      return control.restart();
    },
  };

  return control;
}

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({
      host: '127.0.0.1',
      port,
    });

    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });

/**
 * The existing launcher owns exactly one API process.
 * No package registry or scheduler.
 */
export async function startLauncherControl({
  root = process.cwd(),
  apiPort = registeredPort('snarkroute', 'API_PORT'),
  controlPort = registeredPort('launcher_control', 'SNARKROUTE_LAUNCHER_CONTROL_PORT'),
  projectPublisher = null,
} = {}) {
  root = resolve(root);

  const token = randomBytes(32).toString('hex');

  let child;
  let exited;
  let authorized = false;

  const launch = serverLaunchSpec(
    root,
    apiPort,
    token
  );
  const envFilePath = join(root, '.env');
  const envFileAtStart = readEnvFile(envFilePath);
  const writeServerLog = (line) => {
    try { appendFileSync(serverLogPath(root), `\n[${new Date().toISOString()}] ${line}\n`); } catch {}
  };

  const control = createLauncherRestartControl({
    apiPort,

    owned: () => authorized,

    serverPid: () => child?.pid,

    portOpen: () => portOpen(apiPort),

    healthy: async () => {
      try {
        if (!child) return false;

        const health = await fetch(`http://127.0.0.1:${apiPort}/api/health`, {
          signal: AbortSignal.timeout(1500), redirect: 'error',
        });
        if (health.status !== 200) return false;
        const body = await health.json();
        if (body.service !== 'snarkroute-server' || body.apiVersion !== 1 || body.ok !== true) return false;

        const ownership = await fetch(
          `http://127.0.0.1:${apiPort}/api/system/restart/ownership`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
            signal: AbortSignal.timeout(1500), redirect: 'error',
          }
        );

        if (!ownership.ok) return false;

        const ownershipBody = await ownership.json();

        if (ownershipBody.pid !== child.pid) {
          return false;
        }

        return true;
      } catch {
        return false;
      }
    },

    start: async () => {
      if (child) {
        throw new Error(
          'Server process is already running; refusing duplicate start'
        );
      }

      if (await portOpen(apiPort)) {
        throw new Error(
          'API port already occupied; refusing duplicate start'
        );
      }

      // stdout/stderr go to a log file instead of the launcher's (hidden) console: the
      // Мастерская terminal shows it live, and a failed start points to the real error there.
      const logPath = serverLogPath(root);
      mkdirSync(dirname(logPath), { recursive: true });
      rotateLogIfLarge(logPath);
      const log = openSync(logPath, 'a');
      writeSync(log, `\n[${new Date().toISOString()}] ▶ SnarkRoute API: запуск из Мастерской\n`);

      try {
        child = spawn(
          launch.command,
          launch.args,
          {
            cwd: launch.cwd,

            env: {
              ...launch.env,
              ...refreshedEnvFileValues(envFilePath, launch.env, envFileAtStart),
              API_PORT: launch.env.API_PORT,
              PERSONA_BRIDGE_AUTO_START: launch.env.PERSONA_BRIDGE_AUTO_START,
              SNARKROUTE_LAUNCHER_TOKEN: launch.env.SNARKROUTE_LAUNCHER_TOKEN,
              SNARKROUTE_LAUNCHER_CONTROL_PORT:
                String(controlPort),
            },

            windowsHide: true,

            stdio: [
              'ignore',
              log,
              log,
              'ipc',
            ],
          }
        );
      } finally {
        closeSync(log);
      }

      authorized = true;

      const current = child;

      exited = new Promise((resolve) =>
        current.once('close', () => {
          if (child === current) {
            child = undefined;
            authorized = false;
          }

          resolve();
        })
      );

      await new Promise((resolve, reject) => {
        current.once('spawn', resolve);
        current.once('error', reject);
      });

      try {
        writeFileSync(`${logPath}.launch.json`, JSON.stringify({
          label: 'SnarkRoute API', pid: current.pid, startedAt: new Date().toISOString(),
        }), 'utf8');
      } catch {}
    },

    stop: async () => {
      if (!child) return;

      let response;
      let requestError;

      try {
        response = await fetch(
          `http://127.0.0.1:${apiPort}/api/system/restart/shutdown`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            signal: AbortSignal.timeout(3000),
          }
        );
      } catch (error) {
        requestError = error;
      }

      if (response && !response.ok) {
        throw new Error(
          `Graceful stop rejected (${response.status}); owned process was not killed`
        );
      }

      const exitedWithin = async (ms) => {
        let timer;
        try {
          return await Promise.race([
            exited.then(() => true),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };

      if (await exitedWithin(30_000)) return;

      // The process is our own spawned child, verified by pid; a graceful stop that closed the port
      // but never exited (seen 25.10, 27.10, 28.10) would otherwise leave Мастерская without an API.
      const stuck = child;
      if (stuck) {
        writeServerLog(`▶ SnarkRoute API: PID ${stuck.pid} не завершился за 30 с после остановки, завершаю принудительно`);
        stuck.kill();
      }
      if (await exitedWithin(10_000)) return;

      throw requestError ?? new Error('Graceful stop timeout');
    },

    cleanup: async () => {
      if (!child) return;

      if (child.connected) {
        child.disconnect();
      }

      let timer;

      try {
        await Promise.race([
          exited,

          new Promise((resolve) => {
            timer = setTimeout(() => {
              child?.kill();
              resolve();
            }, 30_000);
          }),
        ]);

        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  });

  const server = createServer(
    async (req, res) => {
      const origin = req.headers.origin;
      const remote = req.socket.remoteAddress;

      if (
        ![
          '127.0.0.1',
          '::1',
          '::ffff:127.0.0.1',
        ].includes(remote) ||
        !allowedControlOrigin(origin) ||
        ![
          '127.0.0.1',
          'localhost',
        ].includes(
          (req.headers.host ?? '').split(':')[0]
        )
      ) {
        res.writeHead(403);
        res.end();
        return;
      }

      if (origin) {
        res.setHeader(
          'Access-Control-Allow-Origin',
          origin
        );
      }

      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Cache-Control',
        'no-store'
      );
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET,POST,OPTIONS'
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type'
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const reply = (code, value) => {
        res.writeHead(code, {
          'Content-Type': 'application/json',
        });

        res.end(JSON.stringify(value));
      };

      const requireJson = async () => {
        if (!req.headers['content-type']?.startsWith('application/json')) {
          reply(415, { ok: false, error: 'JSON required' });
          return false;
        }

        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024) {
            reply(413, { ok: false, error: 'Body too large' });
            return false;
          }
        }
        return true;
      };

      try {
        if (
          req.method === 'GET' &&
          req.url === '/status'
        ) {
          return reply(200, {
            ok: true,
            ...control.status(),
            workspace: root,
          });
        }

        if (
          req.method === 'POST' &&
          req.url === '/restart'
        ) {
          if (!await requireJson()) return;

          const restartOperation = await control.restartOrStart();
          return reply(202, {
            ok: true,
            ...control.status(),
            operation: restartOperation,
          });
        }

        if (
          req.method === 'GET' &&
          req.url === '/project-publisher/status'
        ) {
          if (!projectPublisher) {
            return reply(503, {
              ok: false,
              error: 'Project Publisher control is unavailable',
            });
          }
          return reply(200, {
            ok: true,
            ...await projectPublisher.status(),
          });
        }

        const publisherAction = req.method === 'POST' &&
          req.url?.match(/^\/project-publisher\/(start|stop|restart)$/)?.[1];
        if (publisherAction) {
          if (!projectPublisher) {
            return reply(503, {
              ok: false,
              error: 'Project Publisher control is unavailable',
            });
          }
          if (!await requireJson()) return;
          const next = await projectPublisher[publisherAction]();
          return reply(200, { ok: true, ...next });
        }

        return reply(404, {
          ok: false,
          error: 'Unknown control operation',
        });
      } catch (error) {
        reply(409, {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : String(error),
          ...control.status(),
        });
      }
    }
  );

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);

      server.listen(
        controlPort,
        '127.0.0.1',
        resolve
      );
    });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') {
      throw error;
    }

    const response = await fetch(
      `http://127.0.0.1:${controlPort}/status`,
      {
        signal: AbortSignal.timeout(1500),
      }
    );

    const existing = await response.json();

    if (
      existing.service !==
        'snarkroute-launcher-control' ||
      existing.workspace !== root ||
      existing.apiPort !== apiPort
    ) {
      throw new Error(
        'Control port belongs to another launcher'
      );
    }

    return {
      existing: true,
      control: null,
      server: null,
    };
  }

  return {
    existing: false,
    control,
    server,

    close: async () => {
      await projectPublisher?.shutdown();
      await control.shutdown();

      await new Promise(
        (resolve, reject) =>
          server.close((error) =>
            error ? reject(error) : resolve()
          )
      );
    },
  };
}
