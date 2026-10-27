import assert from 'node:assert/strict';
import { readServiceRegistry } from '../../../scripts/local-service-registry.mjs';

const registry = readServiceRegistry();
const api = `http://${registry.host}:${registry.services.snarkroute.port}`;
const bureau = `http://${registry.host}:${registry.services.buzha.port}`;
async function json(url, data, headers = {}) {
  const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data),
    redirect: 'error', signal: AbortSignal.timeout(185_000) });
  const body = await response.json();
  assert(response.ok, JSON.stringify(body)); return body;
}
const start = await json(`${api}/api/system/apps/buzha/start`, {});
assert.equal(start.running, true); assert.equal(start.automation, false);
assert.deepEqual(await json(`${bureau}/api/health`), { service: 'buzha', ok: true, apiVersion: 1, state: 'ready', automation: false });
const cards = await json(`${api}/api/system/apps`);
assert.equal(cards.apps.find(app => app.id === 'buzha').controllable, true);
const logs = await json(`${api}/api/system/local-runtimes/logs`);
assert(logs.services.some(service => service.id === 'buzha'));
const opened = await json(`${api}/api/system/apps/buzha/open`, {});
assert.equal(opened.url, bureau);
if (process.argv.includes('--chat')) {
  const models = (await json(`${bureau}/api/models`)).models;
  const model = models.find(model => Number(model.pricing?.pricing?.prompt) === 0 && Number(model.pricing?.pricing?.completion) === 0);
  assert(model, 'No confirmed zero-price model in current catalog; choose a model explicitly.');
  const headers = { 'X-Buzha-Token': (await json(`${bureau}/api/session`)).token };
  await json(`${bureau}/api/model`, { model: model.id }, headers);
  await json(`${bureau}/api/message`, { content: 'Проверка подключения. Ответь одной короткой фразой по-русски: бюро готово, автопоиск не подключён.' }, headers);
  // Exactly one explicit inference; never replay a lost or failed response.
  await json(`${bureau}/api/chat`, {}, headers);
  const answer = (await json(`${bureau}/api/state`)).messages.at(-1);
  assert.equal(answer.role, 'assistant'); assert(answer.call?.provenance?.runId);
  console.log(JSON.stringify({ model: answer.call.model, costs: answer.call.costs, runId: answer.call.provenance.runId, answer: answer.content }));
}
const stopped = await json(`${api}/api/system/apps/buzha/stop`, {});
assert.equal(stopped.running, false);
assert.equal((await json(`${api}/api/system/apps/buzha/start`, {})).state, 'ready');
console.log('BUZHA_LIVE_SMOKE_PASS');
