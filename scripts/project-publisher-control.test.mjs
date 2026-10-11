import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProjectPublisherControl, projectPublisherLaunchSpec } from './project-publisher-control.mjs';

function fixture({ external = false } = {}) {
  let clock = 0;
  let open = external;
  let healthy = external;
  let pid = 40;
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push(['spawn', command, args]);
    const child = new EventEmitter();
    child.pid = ++pid;
    child.kill = () => {
      calls.push(['kill', child.pid]);
      open = false;
      healthy = false;
      queueMicrotask(() => child.emit('close', 0));
      return true;
    };
    queueMicrotask(() => {
      open = true;
      healthy = true;
      child.emit('spawn');
    });
    return child;
  };
  const control = createProjectPublisherControl({
    root: 'Y:/Приложения/Project Publisher',
    port: 8765,
    spawnProcess,
    fileExists: () => true,
    portOpen: async () => open,
    healthy: async () => healthy,
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    timeoutMs: 20,
    pollMs: 5,
  });
  return { control, calls };
}

test('starts and stops the exact Project Publisher child', async () => {
  const f = fixture();
  const started = await f.control.start();
  assert.equal(started.running, true);
  assert.equal(started.managed, true);
  assert.equal(started.healthy, true);
  const stopped = await f.control.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.managed, false);
  assert.equal(f.calls.filter(([name]) => name === 'spawn').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'kill').length, 1);
});

test('refuses to stop or replace an external process on the port', async () => {
  const f = fixture({ external: true });
  const status = await f.control.status();
  assert.equal(status.external, true);
  await assert.rejects(f.control.stop(), /вне Мастерской/);
  await assert.rejects(f.control.start(), /занят/);
  assert.deepEqual(f.calls, []);
});

test('launch spec uses the project virtual environment and fixed local port', () => {
  const spec = projectPublisherLaunchSpec('Y:/Приложения/Project Publisher', 8765);
  assert.match(spec.python, /\.venv[\\/]Scripts[\\/]python\.exe$/i);
  assert.deepEqual(spec.args.slice(-4), ['--host', '127.0.0.1', '--port', '8765']);
});
