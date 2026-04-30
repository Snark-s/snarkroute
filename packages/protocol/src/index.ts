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

export const EconomicsSchema = z.object({
  enabled: z.boolean(),
  authorShare: z.number().optional(),
  modelShares: z.array(z.object({ model: z.string(), share: z.number() })).optional(),
  notes: z.string().optional()
});

export const RouteNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string().optional(),
  params: z.record(JsonLikeSchema).optional(),
  inputs: z.record(JsonLikeSchema).optional(),
  outputs: z.record(JsonLikeSchema).optional(),
  ui: z.record(JsonLikeSchema).optional()
});

export const RouteEdgeSchema = z.object({
  id: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1)
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
  economics: EconomicsSchema,
  nodes: z.array(RouteNodeSchema),
  edges: z.array(RouteEdgeSchema),
  provenance: ProvenanceSchema.optional()
});

export type OpenRoute = z.infer<typeof OpenRouteSchema>;
export type RouteNode = z.infer<typeof RouteNodeSchema>;
export type RouteEdge = z.infer<typeof RouteEdgeSchema>;

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

  return {
    ok: issues.length === 0,
    route: issues.length === 0 ? parsed.data : undefined,
    issues
  };
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

export function exportRouteToYaml(route: OpenRoute): string {
  return YAML.stringify(parseRoute(route));
}

export function exportRouteToJson(route: OpenRoute): string {
  return `${JSON.stringify(parseRoute(route), null, 2)}\n`;
}
