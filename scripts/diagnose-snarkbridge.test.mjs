import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseSnarkBridge } from './diagnose-snarkbridge.mjs';

const registry = { host: '127.0.0.1', services: {
  snarkbridge_mcp: { port: 8767, protocol: 'http', healthPath: '/health', identity: { field: 'service', value: 'snarkbridge-mcp' }, apiVersion: 1, readyField: 'ok' },
  snarkbridge_tunnel: { port: 8080, protocol: 'http', healthPath: '/readyz' },
} };
const ready = () => Response.json({ service: 'snarkbridge-mcp', apiVersion: 1, ok: true });

test('healthy local endpoints never assert remote ChatGPT reachability', async () => {
  const result = await diagnoseSnarkBridge(registry, { fetchImpl: async url => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:/);
    return url.includes(':8767') ? ready() : Response.json({ ok: true });
  } });
  assert.equal(result.mcp.state, 'verified');
  assert.equal(result.tunnel.state, 'local_ready');
  assert.equal(result.cloud.state, 'unverified');
  assert.equal(result.connectionVerified, false);
});

test('HTTP 429 is retained as a transport status without response content', async () => {
  const result = await diagnoseSnarkBridge(registry, { fetchImpl: async url => url.includes(':8767') ? ready() : new Response('secret upstream body', { status: 429 }) });
  assert.equal(result.tunnel.state, 'http_error');
  assert.equal(result.tunnel.httpStatus, 429);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('wrong MCP identity or API contract is not ready', async () => {
  for (const body of [{ service: 'foreign', apiVersion: 1, ok: true }, { service: 'snarkbridge-mcp', apiVersion: 2, ok: true }, { service: 'snarkbridge-mcp', apiVersion: 1, ok: false }]) {
    const result = await diagnoseSnarkBridge(registry, { fetchImpl: async () => Response.json(body) });
    assert.equal(result.mcp.state, 'contract_mismatch');
  }
});

test('unreachable endpoints omit exception messages and enforce bounded requests', async () => {
  const result = await diagnoseSnarkBridge(registry, { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    throw new Error('secret token in URL');
  } });
  assert.equal(result.mcp.state, 'unreachable');
  assert.equal(result.tunnel.state, 'unreachable');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('missing or non-loopback registry is rejected before any request', async () => {
  let calls = 0;
  for (const bad of [{ ...registry, host: 'example.com' }, { host: '127.0.0.1', services: {} }]) {
    await assert.rejects(diagnoseSnarkBridge(bad, { fetchImpl: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
});
