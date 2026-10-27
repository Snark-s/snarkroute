import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readServiceRegistry, resolveServiceHome } from '../../../scripts/local-service-registry.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const registry = structuredClone(readServiceRegistry());
const directory = await mkdtemp(join(tmpdir(), 'buzha-ui-'));
const output = resolve(process.env.BUZHA_SMOKE_OUTPUT || 'reports/buzha-ui');
await mkdir(output, { recursive: true });
const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
registry.services.buzha.port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const registryPath = join(directory, 'registry.json');
await writeFile(registryPath, JSON.stringify(registry));
const bureau = `http://127.0.0.1:${registry.services.buzha.port}`;
const appHome = resolveServiceHome('buzha');
let child;
async function request(path, data) {
  const token = data === undefined ? undefined : (await (await fetch(bureau + '/api/session')).json()).token;
  const response = await fetch(bureau + path, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Buzha-Token': token } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data) });
  assert(response.ok, await response.clone().text()); return response.json();
}
async function start() {
  child = spawn(process.env.AUTONOMOUS_APPS_PYTHON || 'python', ['server.py', '--no-browser'], {
    cwd: appHome, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SNARKROUTE_PORT_REGISTRY: registryPath, BUZHA_DATA_DIR: join(directory, 'data'), PYTHONIOENCODING: 'utf-8' }
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', data => process.stderr.write(data));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await request('/api/health')).service === 'buzha') return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Test bureau did not start');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); await request('/api/system/shutdown', {}); await exited;
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  await start();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(bureau); await page.locator('#metrics .metric').first().waitFor();
  await page.locator('nav [data-tab="jobs"]').click();
  await page.locator('#new-job').click();
  await page.locator('#job-form [name="title"]').fill('Проверка сохранения заказа');
  await page.locator('#job-form [name="amount"]').fill('1200');
  await page.locator('#job-form [name="hours"]').fill('1.5');
  await page.locator('#job-form .primary').click();
  await page.locator('#job-list').getByText('Проверка сохранения заказа', { exact: true }).waitFor();
  await page.locator('nav [data-tab="tasks"]').click();
  await page.locator('#task-form input').fill('Вручную проверить исходники');
  await page.locator('#task-form button').click();
  await page.locator('#task-list').getByText('Вручную проверить исходники').waitFor();
  const modelsLoaded = page.waitForFunction(() => document.querySelector('#model-select').options.length > 1);
  await modelsLoaded;
  await page.locator('nav [data-tab="settings"]').click();
  const selected = await page.locator('#model-select option').nth(1).getAttribute('value');
  await page.locator('#model-select').selectOption(selected);
  await page.locator('#model-save').click();
  await page.waitForFunction(model => document.querySelector('#chat-status').textContent.includes(model), selected);
  await stop(); await start(); await page.reload();
  await page.waitForFunction(() => document.querySelector('#metrics .metric:last-child strong')?.textContent === '1');
  const state = await request('/api/state');
  assert.equal(state.jobs[0].title, 'Проверка сохранения заказа');
  assert.equal(state.tasks[0].title, 'Вручную проверить исходники');
  assert.equal(state.model, selected);
  await page.screenshot({ path: join(output, 'buzha-desktop.png'), fullPage: true });
  for (const tab of ['overview', 'jobs', 'tasks', 'chat', 'journal', 'settings']) {
    await page.locator(`nav [data-tab="${tab}"]`).click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Desktop overflow: ${tab}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['overview', 'jobs', 'tasks', 'chat', 'journal', 'settings']) {
    await page.locator(`nav [data-tab="${tab}"]`).click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Mobile overflow: ${tab}`);
  }
  await page.screenshot({ path: join(output, 'buzha-mobile-settings.png'), fullPage: true });
  await page.locator('nav [data-tab="overview"]').click();
  await page.screenshot({ path: join(output, 'buzha-mobile.png'), fullPage: true });
  // The real Workshop card opens the registered, lifecycle-managed instance.
  const workshop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await workshop.goto(`http://127.0.0.1:${registry.services.launcher.port}`);
  const card = workshop.locator('.autonomousCard').filter({ hasText: 'Бужа' });
  await card.locator('.cardMain').waitFor();
  const icon = card.locator('img');
  await icon.evaluate(image => image.complete ? Promise.resolve() : new Promise(resolve => image.onload = resolve));
  assert(await icon.evaluate(image => image.naturalWidth > 0));
  const popup = workshop.waitForEvent('popup'); await card.locator('.cardMain').click();
  const opened = await popup;
  await opened.waitForURL(url => url.port === String(readServiceRegistry().services.buzha.port), { timeout: 70_000 });
  await opened.waitForLoadState('domcontentloaded');
  assert.equal(new URL(opened.url()).port, String(readServiceRegistry().services.buzha.port));
  await workshop.screenshot({ path: join(output, 'buzha-workshop.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: 'UI create order/task, model selection, real restart persistence, desktop/mobile tabs, Workshop icon/open', screenshots: output }));
} finally {
  await browser.close(); await stop();
  // This is the freshly created test directory, never the application's data directory.
  if (resolve(directory).startsWith(resolve(tmpdir()) + '\\') || dirname(directory) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true });
}
