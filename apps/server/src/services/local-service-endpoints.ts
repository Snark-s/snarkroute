import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot } from "../server-paths";

/** Canonical local TCP/HTTP service endpoints. Never infer an LLM from a port. */
export const REQUIRED_LOCAL_SERVICES = [
  "snarkroute", "mixar_sidecar", "mixar_bridge", "mixar_watchdog",
  "snarkbridge_mcp", "snarkbridge_tunnel", "bonsai_inference", "ollama_inference"
] as const;
export type LocalServiceName = typeof REQUIRED_LOCAL_SERVICES[number];
export type RegisteredServiceName = LocalServiceName | "persona_bridge" | "project_publisher"
  | "launcher" | "launcher_control" | "h3_worker" | "h3_sglang_fl2va" | "h3_sglang_ref2va"
  | "local_upscale" | "flux3_native" | "qwen_edit" | "yue2" | "freetoken" | "tove" | "factory";
export type ServiceWatch = "always" | "when_running" | "never";
type Service = { port: number; protocol: "http" | "tcp"; healthPath?: string; watch?: ServiceWatch };
export type ServiceEndpointRegistry = {
  schemaVersion: 1;
  host: "127.0.0.1";
  modelPolicy: { routeVia: "snarkroute"; directMixarInference: false };
  services: Record<LocalServiceName, Service> & Partial<Record<RegisteredServiceName, Service>>;
  paths?: Record<string, string>;
};

export function serviceEndpointRegistry(path = process.env.SNARKROUTE_PORT_REGISTRY?.trim()
  || join(repoRoot, "service-endpoints.json")): ServiceEndpointRegistry {
  const raw: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid local service registry");
  const doc = raw as Partial<ServiceEndpointRegistry>;
  if (doc.schemaVersion !== 1 || doc.host !== "127.0.0.1"
      || doc.modelPolicy?.routeVia !== "snarkroute"
      || doc.modelPolicy?.directMixarInference !== false
      || !doc.services || typeof doc.services !== "object") {
    throw new Error("Invalid SnarkRoute service registry or model policy");
  }
  const ports = new Set<number>();
  const names = Object.keys(doc.services);
  if (REQUIRED_LOCAL_SERVICES.some(name => !names.includes(name))) {
    throw new Error("Local registry has missing service IDs");
  }
  for (const [name, service] of Object.entries(doc.services)) {
    if (!service || !Number.isInteger(service.port) || service.port < 1024
        || service.port > 65535 || ports.has(service.port)
        || !["http","tcp"].includes(service.protocol)
        || (service.watch !== undefined && !["always", "when_running", "never"].includes(service.watch))
        || (service.protocol === "http"
          && (typeof service.healthPath !== "string" || !service.healthPath.startsWith("/")
              || service.healthPath.includes("//")))) {
      throw new Error(`Invalid or duplicated port / health endpoint for ${name}`);
    }
    ports.add(service.port);
  }
  return doc as ServiceEndpointRegistry;
}

export function localServicePort(name: RegisteredServiceName): number {
  const service = serviceEndpointRegistry().services[name];
  if (!service) throw new Error(`Unregistered local service: ${name}`);
  return service.port;
}
export function localServiceUrl(name: RegisteredServiceName, path = ""): string {
  const service = serviceEndpointRegistry().services[name];
  if (!service) throw new Error(`Unregistered local service: ${name}`);
  if (service.protocol !== "http") throw new Error(`${name} is TCP-only`);
  if (path && !path.startsWith("/")) throw new Error("Service path must be absolute");
  return `http://127.0.0.1:${service.port}${path}`;
}
export function localServiceHome(name: string): string | undefined {
  const registryPath = process.env.SNARKROUTE_PORT_REGISTRY?.trim() || join(repoRoot, "service-endpoints.json");
  const path = serviceEndpointRegistry(registryPath).paths?.[name];
  return path ? resolve(registryPath, "..", path) : undefined;
}
export function assertLocalInferenceEndpoint(url: string): void {
  const endpoint = new URL(url);
  const registry = serviceEndpointRegistry();
  const allowed = ["bonsai_inference", "ollama_inference"].map(name => {
    const entry = registry.services[name as LocalServiceName];
    return `http://127.0.0.1:${entry.port}/v1`;
  });
  const canonical = `${endpoint.protocol}//${endpoint.hostname}:${endpoint.port}${endpoint.pathname.replace(/\/+$/, "")}`;
  if (!allowed.includes(canonical) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Unregistered local inference endpoint: use SnarkRoute service-endpoints.json");
  }
}
