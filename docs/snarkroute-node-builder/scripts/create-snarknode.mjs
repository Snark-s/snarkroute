#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const EMPTY_PERMISSIONS = {
  network: false,
  networkHosts: [],
  readFiles: false,
  writeOutputs: false,
  shell: false,
  env: []
};

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLUGIN_RUNTIMES = new Set(["node", "javascript", "typescript"]);

async function main() {
  const specPath = process.argv[2];
  const outputDirectory = process.argv[3] ? resolve(process.argv[3]) : process.cwd();
  if (!specPath) {
    console.error("Usage: node create-snarknode.mjs <spec.json> [output-directory]");
    process.exit(1);
  }

  const spec = JSON.parse(await readFile(resolve(specPath), "utf8"));
  const result = await createSnarkNode(spec, outputDirectory);
  console.log(`Created ${result.manifest.id}`);
  console.log(`Output: ${result.outputPath}`);
  console.log(`Files: ${result.files.join(", ")}`);
}

export async function createSnarkNode(spec, outputDirectory = process.cwd()) {
  const slug = safeSlug(spec.slug ?? spec.name ?? spec.title ?? spec.id ?? "snark-node");
  const title = stringOr(spec.title, titleFromSlug(slug));
  const manifest = buildManifest(spec, slug, title);
  validateManifest(manifest);

  const files = new Map();
  files.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  if (manifest.executor.type === "plugin") files.set(manifest.executor.entry, Buffer.from(pluginExecutorCode(spec), "utf8"));
  if (spec.includeReadme !== false) files.set("README.md", Buffer.from(readmeFor(manifest, spec, slug), "utf8"));
  if (spec.includeExamples) files.set("examples/example.route.json", Buffer.from(`${JSON.stringify(exampleRoute(manifest), null, 2)}\n`, "utf8"));
  validateFileSet(manifest, [...files.keys()]);

  const outputPath = join(resolve(outputDirectory), `${slug}.snarknode`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, zipFiles(files));
  return { slug, outputPath, manifest, files: [...files.keys()].sort() };
}

function buildManifest(spec, slug, title) {
  const executorType = spec.executorType ?? spec.executor?.type ?? (spec.declarative ? "declarative" : spec.generatePluginCode === false ? "declarative" : "plugin");
  const executor = buildExecutor(spec, executorType);
  return {
    kind: "snarkroute.node",
    schemaVersion: "0.1",
    id: safeNodeId(spec.id ?? `custom.${slug}`),
    title,
    version: stringOr(spec.version, "0.1.0"),
    author: normalizeAuthor(spec.author),
    license: stringOr(spec.license, "private"),
    origin: "local",
    source: stringOr(spec.source, "generated-by-snarkroute-node-builder"),
    category: stringOr(spec.category, "Custom"),
    description: stringOr(spec.description, spec.behavior ?? `Generated SnarkRoute node package for ${title}.`),
    generatedWith: { tool: "Codex", skill: "snarkroute-node-builder" },
    permissions: normalizePermissions(spec.permissions, executor),
    executor,
    inputs: requireArray(spec.inputs, "inputs"),
    outputs: requireArray(spec.outputs, "outputs"),
    params: requireArray(spec.params, "params")
  };
}

function buildExecutor(spec, executorType) {
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

function normalizePermissions(value = {}, executor) {
  const permissions = {
    ...EMPTY_PERMISSIONS,
    ...value,
    networkHosts: Array.isArray(value.networkHosts) ? value.networkHosts : [],
    env: Array.isArray(value.env) ? value.env : []
  };
  if (executor.type === "declarative.http" && value.network !== false) permissions.network = true;
  return permissions;
}

function validateManifest(manifest) {
  const issues = [];
  stringEquals(manifest.kind, "snarkroute.node", "kind", issues);
  requiredString(manifest.schemaVersion, "schemaVersion", issues);
  const id = requiredString(manifest.id, "id", issues);
  if (id && !NODE_ID_PATTERN.test(id)) issues.push("id: Node id must use letters, numbers, dots, dashes, or underscores.");
  requiredString(manifest.title, "title", issues);
  requiredString(manifest.version, "version", issues);
  requiredString(manifest.license, "license", issues);
  if (!manifest.author || typeof manifest.author !== "object" || Array.isArray(manifest.author)) issues.push("author: author object is required.");
  else requiredString(manifest.author.name, "author.name", issues);
  if (!["bundled", "local", "installed", "linked", "remote", "generated"].includes(String(manifest.origin))) {
    issues.push('origin: origin must be one of "bundled", "local", "installed", "linked", "remote", or "generated".');
  }
  validatePermissions(manifest.permissions, issues);
  validateExecutor(manifest.executor, issues);
  validatePorts(manifest.inputs, "inputs", issues);
  validatePorts(manifest.outputs, "outputs", issues);
  validatePorts(manifest.params, "params", issues);
  if (issues.length) throw new Error(`Invalid SnarkRoute node manifest:\n${issues.join("\n")}`);
}

function validatePermissions(value, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push("permissions: permissions object is required.");
    return;
  }
  for (const key of ["network", "readFiles", "writeOutputs", "shell"]) {
    if (typeof value[key] !== "boolean") issues.push(`permissions.${key}: ${key} must be boolean.`);
  }
  if (!Array.isArray(value.networkHosts) || !value.networkHosts.every((item) => typeof item === "string")) {
    issues.push("permissions.networkHosts: networkHosts must be an array of strings.");
  }
  if (!Array.isArray(value.env) || !value.env.every((item) => typeof item === "string" && /^[A-Z_][A-Z0-9_]*$/.test(item))) {
    issues.push("permissions.env: env must be an array of environment variable names.");
  }
}

function validateExecutor(value, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push("executor: executor object is required.");
    return;
  }
  if (!["declarative", "declarative.http", "plugin", "builtin"].includes(String(value.type))) {
    issues.push('executor.type: executor.type must be "declarative", "declarative.http", "plugin", or "builtin".');
  }
  if (value.type === "plugin") {
    if (!PLUGIN_RUNTIMES.has(String(value.runtime))) issues.push("executor.runtime: Unsupported plugin runtime.");
    const entry = requiredString(value.entry, "executor.entry", issues);
    if (entry) {
      safePackagePath(entry);
      if (!/\.(js|mjs|cjs|ts)$/i.test(entry)) issues.push("executor.entry: Executor entry must be .js, .mjs, .cjs, or .ts.");
    }
  }
  if (value.type === "declarative.http") {
    const method = String(value.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) issues.push("executor.method: Declarative HTTP method must be GET, POST, PUT, PATCH, or DELETE.");
    requiredString(value.urlTemplate, "executor.urlTemplate", issues);
    if (!["none", "json", "text"].includes(String(value.bodyMode ?? "none"))) issues.push('executor.bodyMode: bodyMode must be "none", "json", or "text".');
  }
}

function validatePorts(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${path}: ${path} must be an array.`);
    return;
  }
  value.forEach((port, index) => {
    if (!port || typeof port !== "object" || Array.isArray(port)) {
      issues.push(`${path}.${index}: Port must be an object.`);
      return;
    }
    requiredString(port.id, `${path}.${index}.id`, issues);
    requiredString(port.type, `${path}.${index}.type`, issues);
    if (port.required !== undefined && typeof port.required !== "boolean") issues.push(`${path}.${index}.required: required must be boolean.`);
  });
}

function validateFileSet(manifest, paths) {
  if (!paths.includes("manifest.json")) throw new Error("Package must include manifest.json.");
  for (const path of paths) safePackagePath(path);
  if (manifest.executor.type === "plugin" && !paths.includes(manifest.executor.entry)) {
    throw new Error(`Plugin package is missing executor file: ${manifest.executor.entry}`);
  }
}

function pluginExecutorCode(spec) {
  if (typeof spec.pluginCode === "string" && spec.pluginCode.trim()) return spec.pluginCode.endsWith("\n") ? spec.pluginCode : `${spec.pluginCode}\n`;
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

function readmeFor(manifest, spec, slug) {
  return `# ${manifest.title}

${manifest.description}

- Node id: \`${manifest.id}\`
- Executor: \`${manifest.executor.type}${manifest.executor.runtime ? `/${manifest.executor.runtime}` : ""}\`
- Permissions: \`${JSON.stringify(manifest.permissions)}\`

${spec.behavior ? `## Behavior\n\n${spec.behavior}\n` : ""}
Import \`${slug}.snarknode\` in SnarkRoute Studio.
`;
}

function exampleRoute(manifest) {
  return {
    routeVersion: "0.1",
    route: { id: `${safeSlug(manifest.title)}-example`, title: `${manifest.title} Example`, author: manifest.author },
    economics: { enabled: false },
    nodes: [{ id: "node", type: manifest.id, params: Object.fromEntries((manifest.params ?? []).map((param) => [param.id, param.default ?? ""])) }],
    edges: []
  };
}

function zipFiles(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  for (const [rawName, data] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const name = safePackagePath(rawName);
    const nameBuffer = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime(now), 10);
    local.writeUInt16LE(dosDate(now), 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime(now), 12);
    central.writeUInt16LE(dosDate(now), 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function safePackagePath(value) {
  const path = String(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || path === "." || path === ".." || path.startsWith("../") || path.includes("/../") || /^(?:[A-Za-z]:|\\\\)/.test(String(value))) {
    throw new Error("Package paths must be relative and cannot escape the package directory.");
  }
  if (path.startsWith(".env") || path.includes("/.env") || path.includes("node_modules/") || path.includes("/node_modules/")) {
    throw new Error(`Package contains unsupported file path: ${path}`);
  }
  return path;
}

function safeSlug(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "snark-node";
}

function safeNodeId(value) {
  const id = String(value).replace(/[^A-Za-z0-9._-]+/g, ".").replace(/^[._-]+|[._-]+$/g, "");
  if (!NODE_ID_PATTERN.test(id)) throw new Error("Node id must use letters, numbers, dots, dashes, or underscores.");
  return id;
}

function normalizeAuthor(author) {
  if (typeof author === "string" && author.trim()) return { name: author.trim() };
  if (author && typeof author === "object" && !Array.isArray(author) && typeof author.name === "string" && author.name.trim()) return { ...author, name: author.name.trim() };
  return { name: "TODO: Author Name" };
}

function requireArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function titleFromSlug(slug) {
  return slug.split("-").filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function requiredString(value, path, issues) {
  if (typeof value !== "string" || !value.trim()) {
    issues.push(`${path}: ${basename(path)} is required.`);
    return "";
  }
  return value.trim();
}

function stringEquals(value, expected, path, issues) {
  if (value !== expected) issues.push(`${path}: ${path} must be "${expected}".`);
}

function dosTime(date) {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
}

function dosDate(date) {
  return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
