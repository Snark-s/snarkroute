#!/usr/bin/env node
import { createConnection } from 'node:net';
import { readServiceRegistry, serviceHealthy, serviceRegistryPath } from './local-service-registry.mjs';

const registry = readServiceRegistry();
const listening = port => new Promise(resolve => {
  const socket = createConnection({ host: registry.host, port });
  const finish = value => { socket.destroy(); resolve(value); };
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(500, () => finish(false));
});
const services = await Promise.all(Object.entries(registry.services).map(async ([id, entry]) => {
  const open = await listening(entry.port);
  let state = open ? 'listening_identity_unverified' : 'stopped';
  if (open && entry.identity) state = await serviceHealthy(id) ? 'verified' : 'identity_or_api_mismatch';
  if (open && id === 'ollama_inference') {
    try {
      const response = await fetch(`http://${registry.host}:${entry.port}/api/version`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
      const data = await response.json();
      state = response.status === 200 && typeof data.version === 'string' && /^\d+\.\d+\.\d+/.test(data.version)
        ? 'ollama_version_contract_verified' : 'identity_or_api_mismatch';
    } catch { state = 'identity_or_api_mismatch'; }
  }
  return { id, port: entry.port, state, enabled: entry.enabled !== false };
}));
console.log(JSON.stringify({ registry: serviceRegistryPath(), capturedAt: new Date().toISOString(), services }, null, 2));
if (services.some(service => service.state === 'identity_or_api_mismatch')) process.exitCode = 1;
