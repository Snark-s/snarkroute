import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function serviceRegistryPath(env = process.env) {
  const explicit = env.SNARKROUTE_PORT_REGISTRY || env.SNARK_SERVICE_ENDPOINTS;
  if (explicit?.trim()) return resolve(explicit.trim());
  if (env.SNARKROUTE_HOME?.trim()) return join(env.SNARKROUTE_HOME.trim(), 'service-endpoints.json');
  const adjacent = join(root, 'service-endpoints.json');
  if (existsSync(adjacent)) return adjacent;
  const pointer = env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'SnarkDream', 'service-endpoints.path');
  if (pointer && existsSync(pointer)) return resolve(readFileSync(pointer, 'utf8').trim());
  throw new Error('Local service registry missing; set SNARKROUTE_PORT_REGISTRY.');
}
export function readServiceRegistry(env = process.env) {
  const doc = JSON.parse(readFileSync(serviceRegistryPath(env), 'utf8'));
  if (doc.schemaVersion !== 1 || doc.host !== '127.0.0.1'
      || doc.modelPolicy?.routeVia !== 'snarkroute' || doc.modelPolicy?.directMixarInference !== false
      || !doc.services || Array.isArray(doc.services)) throw new Error('Invalid local service registry.');
  const ports = new Set();
  for (const [id, service] of Object.entries(doc.services)) {
    if (!Number.isInteger(service.port) || service.port < 1024 || service.port > 65535
      || ports.has(service.port) || !['http', 'tcp'].includes(service.protocol)
      || (service.protocol === 'http' && (typeof service.healthPath !== 'string'
          || !service.healthPath.startsWith('/') || service.healthPath.includes('//')))) {
      throw new Error(`Invalid or duplicated service port/health path: ${id}`);
    }
    ports.add(service.port);
  }
  return doc;
}
export function registeredPort(id, overrideName, env = process.env) {
  const port = readServiceRegistry(env).services[id]?.port;
  if (!port) throw new Error(`Unregistered local service: ${id}`);
  if (overrideName && env[overrideName]?.trim() && Number(env[overrideName]) !== port) {
    throw new Error(`${overrideName} conflicts with service-endpoints.json (${id}).`);
  }
  return port;
}
export function resolveServiceHome(id, env = process.env) {
  const path = readServiceRegistry(env).paths?.[id];
  if (typeof path !== 'string' || !path.trim()) return undefined;
  return resolve(dirname(serviceRegistryPath(env)), path);
}
export async function serviceHealthy(id, { env = process.env, fetchImpl = fetch } = {}) {
  const registry = readServiceRegistry(env);
  const service = registry.services[id];
  if (!service || service.protocol !== 'http' || !service.identity) return false;
  try {
    const response = await fetchImpl(`http://${registry.host}:${service.port}${service.healthPath}`, {
      redirect: 'error', signal: AbortSignal.timeout(1500), headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) return false;
    const body = await response.json();
    return body[service.identity.field] === service.identity.value
      && (service.apiVersion === undefined || body.apiVersion === service.apiVersion)
      && (service.readyField === undefined || body[service.readyField] === true);
  } catch { return false; }
}
