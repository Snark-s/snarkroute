import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EMPTY_PERMISSIONS,
  packNodePackage,
  previewNodePackageArchive,
  validateNodeManifest,
  type NodeExecutorManifest,
  type NodeParamManifest,
  type NodePermissions,
  type NodePortManifest,
  type SnarkNodeManifest
} from "@snarkroute/nodes";

export interface CreateSnarkNodeSpec {
  name?: string;
  slug?: string;
  id?: string;
  title?: string;
  description?: string;
  category?: string;
  version?: string;
  author?: { name?: string; [key: string]: unknown } | string;
  license?: string;
  source?: string;
  permissions?: Partial<NodePermissions>;
  executor?: Partial<NodeExecutorManifest>;
  executorType?: "declarative" | "declarative.http" | "plugin";
  runtime?: "node" | "javascript" | "typescript";
  inputs?: NodePortManifest[];
  outputs?: NodePortManifest[];
  params?: NodeParamManifest[];
  behavior?: string;
  generatePluginCode?: boolean;
  declarative?: boolean;
  includeReadme?: boolean;
  includeExamples?: boolean;
  pluginCode?: string;
}

export interface CreateSnarkNodeOptions {
  outputDirectory?: string;
  keepPackageFolder?: boolean;
}

export interface CreateSnarkNodeResult {
  slug: string;
  packageDirectory: string;
  outputPath: string;
  manifest: SnarkNodeManifest;
  files: string[];
}

const DEFAULT_SCHEMA_VERSION = "0.1";
const DEFAULT_AUTHOR = "TODO: Author Name";

export async function createSnarkNodePackage(spec: CreateSnarkNodeSpec, options: CreateSnarkNodeOptions = {}): Promise<CreateSnarkNodeResult> {
  const slug = safeSlug(spec.slug ?? spec.name ?? spec.title ?? spec.id ?? "snark-node");
  const title = stringOr(spec.title, titleFromSlug(slug));
  const packageRoot = await mkdtemp(join(tmpdir(), `create-snarknode-${slug}-`));
  const packageDirectory = join(packageRoot, `${slug}.snarknode`);
  const outputDirectory = resolve(options.outputDirectory ?? process.cwd());
  const outputPath = join(outputDirectory, `${slug}.snarknode`);
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });

  const manifest = buildManifest(spec, slug, title);
  const validation = validateNodeManifest(manifest);
  if (!validation.ok) {
    await rm(packageRoot, { recursive: true, force: true });
    throw new Error(formatIssues(validation.issues));
  }

  await writeFile(join(packageDirectory, "manifest.json"), `${JSON.stringify(validation.manifest, null, 2)}\n`, "utf8");
  if (validation.manifest!.executor.type === "plugin") {
    await writeFile(join(packageDirectory, validation.manifest!.executor.entry!), pluginExecutorCode(spec), "utf8");
  }
  if (spec.includeReadme !== false) await writeFile(join(packageDirectory, "README.md"), readmeFor(validation.manifest!, spec), "utf8");
  if (spec.includeExamples) {
    await mkdir(join(packageDirectory, "examples"), { recursive: true });
    await writeFile(join(packageDirectory, "examples", "example.route.json"), `${JSON.stringify(exampleRoute(validation.manifest!), null, 2)}\n`, "utf8");
  }

  const packed = await packNodePackage(packageDirectory, outputPath);
  await previewNodePackageArchive(await readFile(packed.outputPath), { source: basename(packed.outputPath), origin: "local" });
  if (!options.keepPackageFolder) await rm(packageRoot, { recursive: true, force: true });
  return { slug, packageDirectory, outputPath: packed.outputPath, manifest: packed.manifest, files: packed.files };
}

function buildManifest(spec: CreateSnarkNodeSpec, slug: string, title: string): SnarkNodeManifest {
  const executorType = spec.executorType ?? spec.executor?.type ?? (spec.declarative ? "declarative" : spec.generatePluginCode === false ? "declarative" : "plugin");
  const executor = buildExecutor(spec, executorType);
  const permissions = normalizePermissions(spec.permissions, executor);
  return {
    kind: "snarkroute.node",
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    id: safeNodeId(spec.id ?? `custom.${slug}`),
    title,
    version: stringOr(spec.version, "0.1.0"),
    author: normalizeAuthor(spec.author),
    license: stringOr(spec.license, "private"),
    origin: "local",
    source: stringOr(spec.source, "generated-by-create-snarknode"),
    category: stringOr(spec.category, "Custom"),
    description: stringOr(spec.description, spec.behavior ?? `Generated SnarkRoute node package for ${title}.`),
    generatedWith: { tool: "Codex", skill: "snarkroute-node-builder" },
    permissions,
    executor,
    inputs: requireArray(spec.inputs, "inputs"),
    outputs: requireArray(spec.outputs, "outputs"),
    params: requireArray(spec.params, "params")
  };
}

function buildExecutor(spec: CreateSnarkNodeSpec, executorType: NodeExecutorManifest["type"]): NodeExecutorManifest {
  if (executorType === "plugin") {
    return {
      ...spec.executor,
      type: "plugin",
      runtime: spec.runtime ?? spec.executor?.runtime ?? "node",
      entry: spec.executor?.entry ?? "executor.ts"
    };
  }
  if (executorType === "declarative.http") {
    return {
      ...spec.executor,
      type: "declarative.http",
      method: spec.executor?.method ?? "POST",
      urlTemplate: spec.executor?.urlTemplate ?? "{{params.endpoint}}",
      bodyMode: spec.executor?.bodyMode ?? "json",
      response: spec.executor?.response ?? { mode: "json" }
    };
  }
  return { ...spec.executor, type: "declarative" };
}

function normalizePermissions(value: Partial<NodePermissions> | undefined, executor: NodeExecutorManifest): NodePermissions {
  const permissions = {
    ...EMPTY_PERMISSIONS,
    ...value,
    networkHosts: Array.isArray(value?.networkHosts) ? value.networkHosts : [],
    env: Array.isArray(value?.env) ? value.env : []
  };
  if (executor.type === "declarative.http" && value?.network !== false) permissions.network = true;
  return permissions;
}

function pluginExecutorCode(spec: CreateSnarkNodeSpec): string {
  if (spec.pluginCode?.trim()) return spec.pluginCode.endsWith("\n") ? spec.pluginCode : `${spec.pluginCode}\n`;
  return `export async function runNode(context) {
  const { inputs, params, env, logger } = context;
  logger.info("Running generated node.");
  return {
    outputs: {
      result: {
        inputs,
        params,
        allowedEnvKeys: Object.keys(env)
      }
    },
    metadata: {
      behavior: ${JSON.stringify(spec.behavior ?? "TODO: implement node behavior.")}
    }
  };
}
`;
}

function readmeFor(manifest: SnarkNodeManifest, spec: CreateSnarkNodeSpec): string {
  return `# ${manifest.title}

${manifest.description ?? "Generated SnarkRoute node package."}

- Node id: \`${manifest.id}\`
- Executor: \`${manifest.executor.type}${manifest.executor.runtime ? `/${manifest.executor.runtime}` : ""}\`
- Permissions: \`${JSON.stringify(manifest.permissions)}\`

${spec.behavior ? `## Behavior\n\n${spec.behavior}\n` : ""}
Import the generated \`${safeSlug(spec.slug ?? spec.name ?? manifest.title)}.snarknode\` file in SnarkRoute Studio.
`;
}

function exampleRoute(manifest: SnarkNodeManifest) {
  return {
    routeVersion: "0.1",
    route: { id: `${safeSlug(manifest.title)}-example`, title: `${manifest.title} Example`, author: manifest.author },
    economics: { enabled: false },
    nodes: [{ id: "node", type: manifest.id, params: Object.fromEntries((manifest.params ?? []).map((param) => [param.id, param.default ?? ""])) }],
    edges: []
  };
}

function safeSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "snark-node";
}

function safeNodeId(value: string): string {
  const id = value.replace(/[^A-Za-z0-9._-]+/g, ".").replace(/^[._-]+|[._-]+$/g, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("Node id must use letters, numbers, dots, dashes, or underscores.");
  return id;
}

function normalizeAuthor(author: CreateSnarkNodeSpec["author"]): SnarkNodeManifest["author"] {
  if (typeof author === "string" && author.trim()) return { name: author.trim() };
  if (author && typeof author === "object" && typeof author.name === "string" && author.name.trim()) return { ...author, name: author.name.trim() };
  return { name: DEFAULT_AUTHOR };
}

function requireArray<T>(value: T[] | undefined, label: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function titleFromSlug(slug: string): string {
  return slug.split("-").filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function formatIssues(issues: Array<{ path: string; message: string }>): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  const outputDirectory = process.argv[3];
  if (!specPath) {
    console.error("Usage: pnpm create-snarknode <spec.json> [output-directory]");
    process.exit(1);
  }
  const spec = JSON.parse(await readFile(resolve(specPath), "utf8")) as CreateSnarkNodeSpec;
  const result = await createSnarkNodePackage(spec, { outputDirectory });
  console.log(`Created ${result.manifest.id}`);
  console.log(`Output: ${result.outputPath}`);
  console.log(`Files: ${result.files.join(", ")}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath || fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  await main();
}
