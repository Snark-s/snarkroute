#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readServiceRegistry } from './local-service-registry.mjs';

// Read-only, loopback-only diagnosis. Never dump response bodies, credentials,
// request headers, browser profiles, or raw exception messages.
export async function diagnoseSnarkBridge(registry, { fetchImpl = fetch } = {}) {
  if (registry?.host !== '127.0.0.1') throw new Error('Loopback registry required');
  const entries = ['snarkbridge_mcp', 'snarkbridge_tunnel'].map(id => {
    const entry = registry.services?.[id];
    if (!entry || entry.protocol !== 'http' || !Number.isInteger(entry.port)
        || entry.port < 1024 || entry.port > 65535 || typeof entry.healthPath !== 'string'
        || !/^\/[a-zA-Z0-9/_-]*$/.test(entry.healthPath)) {
      throw new Error(`Invalid registered endpoint: ${id}`);
    }
    return entry;
  });
  const probe = async (entry, isMcp) => {
    const result = { port: entry.port, path: entry.healthPath };
    try {
      const response = await fetchImpl(`http://127.0.0.1:${entry.port}${entry.healthPath}`, {
        redirect: 'error', signal: AbortSignal.timeout(3000), headers: { Accept: 'application/json' },
      });
      result.httpStatus = response.status;
      if (response.status !== 200) return { ...result, state: 'http_error' };
      if (!isMcp) return { ...result, state: 'local_ready' };
      const body = await response.json();
      const valid = entry.identity && body[entry.identity.field] === entry.identity.value
        && entry.apiVersion !== undefined && body.apiVersion === entry.apiVersion
        && entry.readyField && body[entry.readyField] === true;
      return { ...result, state: valid ? 'verified' : 'contract_mismatch' };
    } catch {
      return { ...result, state: 'unreachable' };
    }
  };
  const [mcp, tunnel] = await Promise.all([probe(entries[0], true), probe(entries[1], false)]);
  const nextStep = mcp.state !== 'verified' ? 'inspect_local_mcp'
    : tunnel.state !== 'local_ready' ? 'inspect_tunnel_diagnostics'
    : 'verify_bridge_status_from_chatgpt';
  return {
    service: 'snarkbridge-diagnostics', capturedAt: new Date().toISOString(),
    mcp, tunnel, cloud: { state: 'unverified' }, connectionVerified: false, nextStep,
    note: 'Local health cannot prove a working OpenAI tunnel or access to the Buzha Chrome profile.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await diagnoseSnarkBridge(readServiceRegistry());
    console.log(JSON.stringify(report, null, 2));
    if (report.mcp.state !== 'verified' || report.tunnel.state !== 'local_ready') process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ service: 'snarkbridge-diagnostics', state: 'registry_error',
      nextStep: 'check_SNARKROUTE_PORT_REGISTRY', connectionVerified: false }));
    process.exitCode = 2;
  }
}
