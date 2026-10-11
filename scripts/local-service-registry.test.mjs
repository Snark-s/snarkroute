import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServiceRegistry, registeredPort, serviceHealthy, resolveServiceHome } from './local-service-registry.mjs';

test('registry rejects duplicate ports and conflicting overrides', () => {
  const registry = readServiceRegistry();
  assert.equal(registeredPort('snarkroute', 'API_PORT', {}), registry.services.snarkroute.port);
  assert.throws(() => registeredPort('snarkroute', 'API_PORT', { API_PORT: '8080' }), /conflicts/);
  const dir = mkdtempSync(join(tmpdir(), 'snark-registry-'));
  try {
    registry.services.bonsai_inference.port = registry.services.snarkbridge_tunnel.port;
    const path = join(dir, 'service-endpoints.json');
    writeFileSync(path, JSON.stringify(registry));
    assert.throws(() => readServiceRegistry({ SNARKROUTE_PORT_REGISTRY: path }), /duplicated/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP 404, redirects, wrong identity and wrong API version never indicate readiness', async () => {
  for (const response of [
    new Response('{}', { status: 404 }),
    new Response('{}', { status: 302 }),
    Response.json({ ok: true, service: 'foreign', apiVersion: 1 }),
    Response.json({ ok: true, service: 'snarkroute-server', apiVersion: 2 }),
  ]) {
    assert.equal(await serviceHealthy('snarkroute', { fetchImpl: async () => response }), false);
  }
  assert.equal(await serviceHealthy('snarkroute', { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return Response.json({ ok: true, service: 'snarkroute-server', apiVersion: 1 });
  } }), true);
});

test('paths resolve relative to the registry after relocating the installation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snark-relocated-'));
  try {
    const registry = readServiceRegistry();
    registry.paths = { personacore: '../PersonaCore' };
    const path = join(dir, 'service-endpoints.json');
    writeFileSync(path, JSON.stringify(registry));
    assert.equal(resolveServiceHome('personacore', { SNARKROUTE_PORT_REGISTRY: path }), join(dir, '..', 'PersonaCore'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
