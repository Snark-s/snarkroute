/**
 * FLUX.3 Image Klein via a trusted local ComfyUI API workflow.
 * The model weights and ComfyUI installation are deliberately external to SnarkRoute.
 * Workflow is owner-supplied JSON exported via "Save (API Format)".
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { NodeRunner } from "@snarkroute/executor";

export const FLUX3_MODEL_ID = "flux-3-image-klein-int8";
export const FLUX3_WORKFLOW_ENV = "FLUX3_COMFY_WORKFLOW_PATH";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8188";
const TEMPLATE_RE = /^\{\{(prompt|seed|width|height|steps|image(?:10|[1-9]))\}\}$/;
const ANY_TEMPLATE_RE = /\{\{[^}]+\}\}/;
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: Record<string, unknown> }>;

function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = (env.FLUX3_COMFY_URL || DEFAULT_ENDPOINT).trim();
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      parsed.username || parsed.password || (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error("FLUX3_COMFY_URL must be a loopback HTTP origin.");
  }
  return parsed.origin;
}

export async function flux3Status(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}) {
  const env = options.env ?? process.env;
  const endpoint = baseUrl(env);
  const template = env.FLUX3_COMFY_WORKFLOW_PATH?.trim();
  if (!template) return { ready: false, reason: "FLUX3_COMFY_WORKFLOW_PATH is not configured", endpoint };
  try {
    const graph = parseWorkflow(await readFile(resolve(template), "utf8"));
    const res = await (options.fetchImpl ?? fetch)(endpoint + "/system_stats", { signal: AbortSignal.timeout(3500) });
    if (!res.ok) throw new Error("ComfyUI HTTP " + res.status);
    return { ready: true, reason: "", endpoint, workflowNodes: Object.keys(graph).length };
  } catch (error) {
    return { ready: false, reason: error instanceof Error ? error.message : "ComfyUI unavailable", endpoint };
  }
}

export function parseWorkflow(raw: string): Graph {
  const graph: unknown = JSON.parse(raw);
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) throw new Error("Expected ComfyUI API-format workflow object.");
  const nodes = graph as Record<string, unknown>;
  if (!Object.values(nodes).some(node => {
    const n = node as Record<string, unknown> | null;
    return n && (n.class_type === "SaveImage" || n.class_type === "PreviewImage");
  })) throw new Error("FLUX.3 workflow needs a SaveImage or PreviewImage node.");
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== "object" || Array.isArray(node) || typeof (node as Record<string, unknown>).class_type !== "string" ||
        !(node as Record<string, unknown>).inputs || typeof (node as Record<string, unknown>).inputs !== "object") {
      throw new Error("Invalid ComfyUI API-format node.");
    }
  }
  if (!raw.includes("{{prompt}}")) throw new Error("FLUX.3 workflow needs {{prompt}} in the text conditioning node.");
  return nodes as Graph;
}

export function fillWorkflow(graph: Graph, variables: Record<string, string | number>): Graph {
  const convert = (value: unknown): unknown => {
    if (typeof value === "string") {
      const match = TEMPLATE_RE.exec(value);
      if (match) {
        if (!Object.prototype.hasOwnProperty.call(variables, match[1])) throw new Error("Missing workflow value: " + match[1]);
        return variables[match[1]];
      }
      if (ANY_TEMPLATE_RE.test(value)) throw new Error("Workflow placeholders must be whole input values, not embedded strings.");
    }
    if (Array.isArray(value)) return value.map(convert);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,convert(v)]));
    return value;
  };
  return convert(graph) as Graph;
}

function imageInputs(value: unknown): Array<{ path: string; filename: string }> {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  if (values.length > 10) throw new Error("FLUX.3 Klein accepts at most ten reference images.");
  return values.map(item => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const path = typeof item === "string" ? item : typeof record.localPath === "string" ? record.localPath : record.path;
    if (typeof path !== "string" || !path.trim()) throw new Error("Reference image must contain a local file path.");
    if (!/\.(png|jpe?g|webp)$/i.test(path)) throw new Error("Only PNG, JPEG or WEBP references are supported.");
    return { path, filename: basename(path) };
  });
}
function numberParam(value: unknown, fallback: number, min: number, max: number, step = 1) {
  const n = typeof value === "number" ? value : value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || n % step !== 0) throw new Error("Invalid FLUX.3 numeric parameter: " + String(value));
  return n;
}
function unwrapError(history: Record<string, unknown>): string | null {
  const status = history.status as Record<string, unknown> | undefined;
  if (!status || status.status_str !== "error") return null;
  return "ComfyUI FLUX.3 workflow failed: " + JSON.stringify(status.messages ?? []).slice(0, 600);
}

export function createFlux3ComfyNodeRunner(options: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; pollMs?: number } = {}): NodeRunner {
  const env = options.env ?? process.env;
  const fetcher = options.fetchImpl ?? fetch;
  return async ({ node, params, inputs, context }) => {
    const endpoint = baseUrl(env);
    const workflowPath = env.FLUX3_COMFY_WORKFLOW_PATH?.trim();
    if (!workflowPath) throw new Error("FLUX.3 is not configured: set FLUX3_COMFY_WORKFLOW_PATH to a trusted API-format ComfyUI workflow.");
    const rawWorkflow = await readFile(resolve(workflowPath), "utf8");
    const graph = parseWorkflow(rawWorkflow);
    const prompt = String(params.prompt ?? inputs.prompt ?? "").trim();
    if (!prompt) throw new Error("FLUX.3 requires a prompt.");
    const references = imageInputs(params.images ?? params.image ?? inputs.images ?? inputs.image);
    const width = numberParam(params.width, 1024, 256, 4096, 16);
    const height = numberParam(params.height, 1024, 256, 4096, 16);
    const steps = numberParam(params.steps, 16, 1, 100);
    const seed = numberParam(params.seed, 0, 0, 2147483647);
    const request = async (path: string, init?: RequestInit, timeout = 30000) => {
      const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
      const response = await fetcher(endpoint + path, { ...init, signal });
      if (!response.ok) throw new Error("ComfyUI " + path.split("?")[0] + ": HTTP " + response.status + " " + (await response.text()).slice(0, 350));
      return response;
    };
    const variables: Record<string, string | number> = { prompt, width, height, steps, seed };
    for (let i = 0; i < references.length; i++) {
      const ref = references[i];
      const placeholder = "{{image" + (i+1) + "}}";
      if (!rawWorkflow.includes(placeholder)) throw new Error("Workflow does not bind reference " + (i+1) + " (" + placeholder + ").");
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(await readFile(ref.path))]), ref.filename);
      form.append("overwrite", "false");
      const result = await (await request("/upload/image", { method: "POST", body: form }, 120000)).json() as { name?: string };
      if (!result.name) throw new Error("ComfyUI did not accept reference " + (i+1));
      variables["image"+(i+1)] = result.name;
    }
    const filled = fillWorkflow(graph, variables);
    const created = await (await request("/prompt", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: filled, client_id: "snarkroute-flux3" })
    })).json() as { prompt_id?: string; error?: string; node_errors?: unknown };
    if (!created.prompt_id) throw new Error("ComfyUI rejected FLUX.3 workflow: " + JSON.stringify(created).slice(0,500));
    const deadline = Date.now() + 15*60*1000;
    while (Date.now() < deadline) {
      if (context.signal?.aborted) throw new Error("FLUX.3 request cancelled locally; ComfyUI may still be processing.");
      const response = await (await request("/history/" + encodeURIComponent(created.prompt_id), undefined, 20000)).json() as Record<string, unknown>;
      const history = response[created.prompt_id] as Record<string, unknown> | undefined;
      if (history) {
        const failure = unwrapError(history);
        if (failure) throw new Error(failure);
        const outputs = history.outputs as Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }> | undefined;
        const image = Object.values(outputs ?? {}).flatMap(entry => entry.images ?? [])[0];
        if (image?.filename) {
          const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
          const bytes = Buffer.from(await (await request("/view?" + query.toString(), undefined, 60000)).arrayBuffer());
          const folder = join(context.outputDirectory, "assets");
          await mkdir(folder, { recursive: true });
          const filename = node.id + "-" + created.prompt_id + ".png";
          const path = join(folder, filename);
          await writeFile(path, bytes);
          const descriptor = { path, localPath: path, filename, mimeType: "image/png", sizeBytes: bytes.length };
          return { output: { image: descriptor, images: [descriptor], provider: "flux3_comfy", model: FLUX3_MODEL_ID, estimatedCost: 0, actualCost: 0 },
            provenance: { provider: "flux3_comfy", model: FLUX3_MODEL_ID, promptId: created.prompt_id, steps, seed, width, height },
            providerUsage: { provider: "flux3_comfy", model: FLUX3_MODEL_ID, nodeId: node.id, nodeType: node.type, externalId: created.prompt_id, status: "succeeded", estimatedCost: 0, actualCost: 0, pricingHint: "local-inference-zero-api-cost" } };
        }
      }
      await new Promise(res => setTimeout(res, options.pollMs ?? 1000));
    }
    throw new Error("FLUX.3 ComfyUI request timed out; check ComfyUI history for prompt " + created.prompt_id);
  };
}
