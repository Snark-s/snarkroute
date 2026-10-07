import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  pollMs = 300,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  let operation = null;
  let inflight;

  const until = async (predicate, message) => {
    const deadline = now() + timeoutMs;

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

  return {
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
            'Server port did not close; replacement was not started'
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
  };
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
  apiPort = 4317,
  controlPort = 5176,
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

  const control = createLauncherRestartControl({
    apiPort,

    owned: () => authorized,

    serverPid: () => child?.pid,

    portOpen: () => portOpen(apiPort),

    healthy: async () => {
      try {
        if (!child) return false;

        const ownership = await fetch(
          `http://127.0.0.1:${apiPort}/api/system/restart/ownership`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
            signal: AbortSignal.timeout(1500),
          }
        );

        if (!ownership.ok) return false;

        const ownershipBody = await ownership.json();

        if (ownershipBody.pid !== child.pid) {
          return false;
        }

        const response = await fetch(
          `http://127.0.0.1:${apiPort}/api/health`,
          {
            signal: AbortSignal.timeout(1500),
          }
        );

        return response.ok;
      } catch {
        return false;
      }
    },

    start: async () => {
      if (await portOpen(apiPort)) {
        throw new Error(
          'API port already occupied; refusing duplicate start'
        );
      }

      child = spawn(
        launch.command,
        launch.args,
        {
          cwd: launch.cwd,

          env: {
            ...launch.env,
            SNARKROUTE_LAUNCHER_CONTROL_PORT:
              String(controlPort),
          },

          windowsHide: true,

          // ВАЖНО:
          // stdout/stderr теперь видны в консоли launcher.
          // Если сервер снова не стартует,
          // мы увидим настоящую ошибку сразу.
          stdio: [
            'ignore',
            'inherit',
            'inherit',
            'ipc',
          ],
        }
      );

      authorized = true;

      const current = child;

      exited = new Promise((resolve) =>
        current.once('close', () => {
          if (child === current) {
            child = undefined;
          }

          resolve();
        })
      );

      await new Promise((resolve, reject) => {
        current.once('spawn', resolve);
        current.once('error', reject);
      });
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

      let timer;

      try {
        await Promise.race([
          exited,

          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  requestError ??
                    new Error(
                      'Graceful stop timeout'
                    )
                ),
              30_000
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
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
          if (
            !req.headers[
              'content-type'
            ]?.startsWith('application/json')
          ) {
            return reply(415, {
              ok: false,
              error: 'JSON required',
            });
          }

          let size = 0;

          for await (const chunk of req) {
            size += chunk.length;

            if (size > 1024) {
              return reply(413, {
                ok: false,
                error: 'Body too large',
              });
            }
          }

          return reply(202, {
            ok: true,
            ...control.status(),
            operation: control.restart(),
          });
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