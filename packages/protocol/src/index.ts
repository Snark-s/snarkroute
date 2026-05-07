import YAML from "yaml";
import { z } from "zod";

const JsonLikeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonLikeSchema),
    z.record(JsonLikeSchema)
  ])
);

export const AuthorSchema = z.object({
  name: z.string().optional(),
  did: z.string().nullable().optional(),
  wallet: z.string().nullable().optional()
});

const ShareSchema = z.number().min(0).max(1);

export const EconomicsPersonSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    role: z.enum(["route-author", "artist", "developer", "other"]).or(z.string()).optional(),
    share: ShareSchema.optional(),
    wallet: z.string().nullable().optional(),
    did: z.string().nullable().optional()
  })
  .catchall(z.unknown());

export const EconomicsSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["metadata-only", "accounting-only", "disabled"]).optional(),
    currency: z.string().optional(),
    author: EconomicsPersonSchema.optional(),
    contributors: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            role: z.string().optional(),
            share: ShareSchema.optional(),
            wallet: z.string().nullable().optional(),
            did: z.string().nullable().optional()
          })
          .catchall(z.unknown())
      )
      .optional(),
    revenueSplits: z
      .array(
        z
          .object({
            recipientId: z.string(),
            share: ShareSchema,
            reason: z.string().optional()
          })
          .catchall(z.unknown())
      )
      .optional(),
    providerCosts: z
      .array(
        z
          .object({
            provider: z.string(),
            model: z.string().optional(),
            nodeType: z.string().optional(),
            pricingHint: z.string().optional(),
            estimatedCost: z.number().nullable().optional(),
            actualCost: z.number().nullable().optional()
          })
          .catchall(z.unknown())
      )
      .optional(),
    notes: z.string().optional(),
    authorShare: ShareSchema.optional(),
    modelShares: z.array(z.object({ model: z.string(), share: ShareSchema })).optional()
  })
  .catchall(z.unknown())
  .superRefine((economics, context) => {
    const splitSum = economics.revenueSplits?.reduce((sum, split) => sum + split.share, 0) ?? 0;
    if (splitSum > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revenueSplits"],
        message: `revenueSplits share sum must be <= 1, got ${splitSum}`
      });
    }
  });

export const CompoundPortSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    kind: z.enum(["text", "image", "video", "file", "json", "data"]).or(z.string()).optional(),
    nodeId: z.string().min(1),
    port: z.string().min(1).optional()
  })
  .catchall(z.unknown());

export const CompoundInterfaceSchema = z
  .object({
    title: z.string().optional(),
    inputs: z.array(CompoundPortSchema).optional(),
    outputs: z.array(CompoundPortSchema).optional()
  })
  .catchall(z.unknown());

export const CapabilityNodeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    provider: z.string().min(1).optional(),
    providerParams: z.record(JsonLikeSchema).optional(),
    resources: z.array(z.string().min(1)).optional()
  })
  .catchall(z.unknown());

export const RouteNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string().optional(),
  params: z.record(JsonLikeSchema).optional(),
  inputs: z.record(JsonLikeSchema).optional(),
  outputs: z.record(JsonLikeSchema).optional(),
  compound: CompoundInterfaceSchema.optional(),
  capability: CapabilityNodeSchema.optional(),
  subroute: z.unknown().optional(),
  nodePackage: z
    .object({
      id: z.string().optional(),
      version: z.string().optional(),
      source: z.string().optional(),
      origin: z.string().optional()
    })
    .catchall(z.unknown())
    .optional(),
  ui: z.record(JsonLikeSchema).optional()
});

export const RouteEdgeSchema = z.object({
  id: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  fromPort: z.string().min(1).optional(),
  toPort: z.string().min(1).optional()
});

export const ProvenanceSchema = z.object({
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  tool: z.string().optional(),
  events: z.array(z.unknown()).optional()
});

export const OpenRouteSchema = z.object({
  routeVersion: z.string().min(1),
  route: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    author: AuthorSchema,
    license: z.string().optional(),
    tags: z.array(z.string()).optional()
  }),
  economics: EconomicsSchema.optional(),
  nodes: z.array(RouteNodeSchema),
  edges: z.array(RouteEdgeSchema),
  resources: z
    .array(
      z
        .object({
          id: z.string().min(1),
          kind: z.enum(["character", "location", "style", "promptPreset"]).or(z.string()),
          title: z.string().min(1).optional(),
          description: z.string().optional(),
          prompt: z.string().optional(),
          refs: z.array(z.string()).optional()
        })
        .catchall(z.unknown())
    )
    .optional(),
  provenance: ProvenanceSchema.optional()
});

export type OpenRoute = z.infer<typeof OpenRouteSchema>;
export type RouteNode = z.infer<typeof RouteNodeSchema>;
export type RouteEdge = z.infer<typeof RouteEdgeSchema>;
export type CompoundInterface = z.infer<typeof CompoundInterfaceSchema>;
export type CapabilityNode = z.infer<typeof CapabilityNodeSchema>;
export type RouteDocumentFormat = "json" | "yaml";

export type NodeRefKind = "input" | "output";

export interface NodeRef {
  nodeId: string;
  kind: NodeRefKind;
  port: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  route?: OpenRoute;
  issues: ValidationIssue[];
}

export function parseRoute(input: unknown): OpenRoute {
  const parsed = OpenRouteSchema.parse(input);
  const validation = validateRoute(parsed);
  if (!validation.ok) {
    const message = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(message);
  }
  return parsed;
}

export function validateRoute(input: unknown): ValidationResult {
  const parsed = OpenRouteSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "<root>",
        message: issue.message
      }))
    };
  }

  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();

  for (const node of parsed.data.nodes) {
    if (ids.has(node.id)) {
      issues.push({ path: `nodes.${node.id}`, message: `Duplicate node id "${node.id}"` });
    }
    ids.add(node.id);
  }

  for (const edge of parsed.data.edges) {
    if (!ids.has(edge.from)) {
      issues.push({ path: `edges.${edge.id ?? `${edge.from}->${edge.to}`}.from`, message: `Missing source node "${edge.from}"` });
    }
    if (!ids.has(edge.to)) {
      issues.push({ path: `edges.${edge.id ?? `${edge.from}->${edge.to}`}.to`, message: `Missing target node "${edge.to}"` });
    }
  }

  for (const node of parsed.data.nodes) {
    if (node.type !== "library.prompt") continue;
    const params = node.params ?? {};
    const mode = typeof params.mode === "string" ? params.mode : "";
    const category = typeof params.category === "string" ? params.category.trim() : "";
    const promptId = typeof params.promptId === "string" ? params.promptId.trim() : "";
    const embeddedText = typeof params.embeddedText === "string" ? params.embeddedText.trim() : "";
    const nodePath = `nodes.${node.id}.params`;

    if (!mode) issues.push({ path: `${nodePath}.mode`, message: "mode is required for library.prompt." });
    if (mode !== "linked" && mode !== "embedded") issues.push({ path: `${nodePath}.mode`, message: 'mode must be "linked" or "embedded".' });
    if (mode === "linked" && !category) issues.push({ path: `${nodePath}.category`, message: "category is required when library.prompt mode is linked." });
    if (mode === "linked" && !promptId) issues.push({ path: `${nodePath}.promptId`, message: "promptId is required when library.prompt mode is linked." });
    if (mode === "embedded" && !embeddedText) issues.push({ path: `${nodePath}.embeddedText`, message: "embeddedText is required when library.prompt mode is embedded." });
  }

  for (const node of parsed.data.nodes) {
    if (node.type === "http.request") {
      validateHttpRequestNode(node, issues);
    }
    if (node.type === "local.stableDiffusion.textToImage") {
      validateLocalStableDiffusionNode(node, parsed.data.edges, issues);
    }
  }

  return {
    ok: issues.length === 0,
    route: issues.length === 0 ? parsed.data : undefined,
    issues
  };
}

function validateHttpRequestNode(node: RouteNode, issues: ValidationIssue[]): void {
  const params = node.params ?? {};
  const nodePath = `nodes.${node.id}.params`;
  const method = typeof params.method === "string" ? params.method.toUpperCase() : "";
  if (!stringValue(params.url)) issues.push({ path: `${nodePath}.url`, message: "url is required for http.request." });
  if (!method) issues.push({ path: `${nodePath}.method`, message: "method is required for http.request." });
  if (method && !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    issues.push({ path: `${nodePath}.method`, message: "method must be GET, POST, PUT, PATCH, or DELETE." });
  }
  if (params.headers !== undefined) validateJsonObjectLike(params.headers, `${nodePath}.headers`, "headers", issues);
  if (params.query !== undefined) validateJsonObjectLike(params.query, `${nodePath}.query`, "query", issues);
  if (params.queryParams !== undefined) validateJsonObjectLike(params.queryParams, `${nodePath}.queryParams`, "queryParams", issues);
  if (params.bodyMode === "rawJson" && typeof params.body === "string") validateJsonText(params.body, `${nodePath}.body`, "body JSON", issues);
}

function validateLocalStableDiffusionNode(node: RouteNode, edges: RouteEdge[], issues: ValidationIssue[]): void {
  const params = node.params ?? {};
  const nodePath = `nodes.${node.id}.params`;
  if (!stringValue(params.endpoint)) issues.push({ path: `${nodePath}.endpoint`, message: "endpoint is required for local.stableDiffusion.textToImage." });
  const hasPromptInput = edges.some((edge) => edge.to === node.id && (!edge.toPort || edge.toPort === "prompt"));
  if (!stringValue(params.prompt) && !hasPromptInput) issues.push({ path: `${nodePath}.prompt`, message: "prompt is required for local.stableDiffusion.textToImage unless a prompt input is connected." });
  for (const key of ["width", "height", "steps", "cfgScale", "batchSize"] as const) {
    const value = params[key];
    const number = Number(typeof value === "string" ? value.replace(",", ".") : value);
    if (!Number.isFinite(number)) {
      issues.push({ path: `${nodePath}.${key}`, message: `${key} must be a valid number.` });
    } else if (number <= 0) {
      issues.push({ path: `${nodePath}.${key}`, message: `${key} must be positive.` });
    }
  }
}

function validateJsonObjectLike(value: unknown, path: string, label: string, issues: ValidationIssue[]): void {
  const parsed = typeof value === "string" ? safeJsonParse(value) : { ok: true as const, value };
  if (!parsed.ok) {
    issues.push({ path, message: `${label} must be valid JSON.` });
    return;
  }
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    issues.push({ path, message: `${label} must be a JSON object.` });
  }
}

function validateJsonText(value: string, path: string, label: string, issues: ValidationIssue[]): void {
  const parsed = safeJsonParse(value);
  if (!parsed.ok) issues.push({ path, message: `${label} must be valid JSON.` });
}

function safeJsonParse(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseNodeRef(ref: string): NodeRef {
  const match = /^([A-Za-z0-9_-]+)\.(input|output)\.([A-Za-z0-9_.-]+)$/.exec(ref);
  if (!match) {
    throw new Error(`Invalid node reference "${ref}". Expected nodeId.input.port or nodeId.output.port.`);
  }
  return {
    nodeId: match[1],
    kind: match[2] as NodeRefKind,
    port: match[3]
  };
}

export function nodeRefToString(ref: NodeRef): string {
  return `${ref.nodeId}.${ref.kind}.${ref.port}`;
}

export function loadRouteFromYaml(text: string): OpenRoute {
  return parseRoute(YAML.parse(text));
}

export function loadRouteFromJson(text: string): OpenRoute {
  return parseRoute(JSON.parse(text));
}

export function loadRouteFromText(text: string, filename: string): OpenRoute {
  const format = getRouteFormatFromFilename(filename);
  if (!format) {
    throw new Error(
      `Unsupported route file extension for "${filename}". Preferred extension: .orp. Also supports .orp.json, .orp.yaml, .route, .json, and .yaml.`
    );
  }
  return format === "yaml" ? loadRouteFromYaml(text) : loadRouteFromJson(text);
}

export function exportRouteToYaml(route: OpenRoute): string {
  return YAML.stringify(parseRoute(route));
}

export function exportRouteToJson(route: OpenRoute): string {
  return `${JSON.stringify(parseRoute(route), null, 2)}\n`;
}

export function exportRouteToText(route: OpenRoute, filename: string): string {
  const format = getRouteFormatFromFilename(normalizeRouteExportFilename(filename)) ?? "json";
  return format === "yaml" ? exportRouteToYaml(route) : exportRouteToJson(route);
}

const routeJsonExtensions = [".orp", ".orp.json", ".route", ".route.json"] as const;
const routeYamlExtensions = [".orp.yaml", ".orp.yml", ".route.yaml", ".route.yml"] as const;
const plainRouteJsonExtensions = [".json"] as const;
const plainRouteYamlExtensions = [".yaml", ".yml"] as const;
const nodeJsonExtensions = [".node.json"] as const;
const nodeYamlExtensions = [".node.yaml", ".node.yml"] as const;

export function isOpenRouteFile(filename: string): boolean {
  return isRouteFile(filename);
}

export function isRouteFile(filename: string): boolean {
  return hasAnyExtension(filename, [...routeJsonExtensions, ...routeYamlExtensions]);
}

export function isRouteJsonFile(filename: string): boolean {
  return hasAnyExtension(filename, routeJsonExtensions);
}

export function isRouteYamlFile(filename: string): boolean {
  return hasAnyExtension(filename, routeYamlExtensions);
}

export function isNodeDefinitionFile(filename: string): boolean {
  return getNodeFormatFromFilename(filename) !== null;
}

export function getRouteFormatFromFilename(filename: string): RouteDocumentFormat | null {
  if (isNodeDefinitionFile(filename)) return null;
  if (hasAnyExtension(filename, [...routeJsonExtensions, ...plainRouteJsonExtensions])) return "json";
  if (hasAnyExtension(filename, [...routeYamlExtensions, ...plainRouteYamlExtensions])) return "yaml";
  return null;
}

export function getNodeFormatFromFilename(filename: string): RouteDocumentFormat | null {
  if (hasAnyExtension(filename, nodeJsonExtensions)) return "json";
  if (hasAnyExtension(filename, nodeYamlExtensions)) return "yaml";
  return null;
}

export function normalizeRouteExportFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) return "route.orp";
  return isRouteFile(trimmed) ? trimmed : `${trimmed}.orp`;
}

function hasAnyExtension(filename: string, extensions: readonly string[]): boolean {
  const normalized = filename.trim().toLowerCase();
  return extensions.some((extension) => normalized.endsWith(extension));
}
