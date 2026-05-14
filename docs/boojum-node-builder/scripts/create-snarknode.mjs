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
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const MAX_PACKAGE_FILE_COUNT = 200;

async function main() {
  const specPath = process.argv[2];
  const outputDirectory = process.argv[3] ? resolve(process.argv[3]) : process.cwd();
  if (!specPath) {
    console.error("Usage: node create-snarknode.mjs <spec.json> [output-directory]");
    process.exit(1);
  }

  const spec = JSON.parse(stripBom(await readFile(resolve(specPath), "utf8")));
  const result = await createSnarkNode(spec, outputDirectory);
  console.log(`Created ${result.manifest.id}`);
  console.log(`Output: ${result.outputPath}`);
  console.log(`Files: ${result.files.join(", ")}`);
}

export async function createSnarkNode(spec, outputDirectory = process.cwd()) {
  spec = applyStudioProfile(spec);
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
  return removeUndefined({
    kind: "snarkroute.node",
    schemaVersion: "0.1",
    id: safeNodeId(spec.id ?? `custom.${slug}`),
    title,
    version: stringOr(spec.version, "0.1.0"),
    author: normalizeAuthor(spec.author),
    license: stringOr(spec.license, "private"),
    origin: "local",
    source: stringOr(spec.source, "generated-by-boojum-node-builder"),
    category: stringOr(spec.category, "Custom"),
    description: stringOr(spec.description, spec.behavior ?? `Generated Boojum node package for ${title}.`),
    generatedWith: { tool: "Codex", skill: "boojum-node-builder" },
    permissions: normalizePermissions(spec.permissions, executor),
    executor,
    inputs: requireArray(spec.inputs, "inputs"),
    outputs: requireArray(spec.outputs, "outputs"),
    params: requireArray(spec.params, "params"),
    capabilities: spec.capabilities,
    ui: spec.ui,
    icon: spec.icon ?? defaultIconForSpec(spec),
    tags: spec.tags,
    homepage: spec.homepage,
    repository: spec.repository,
    examples: spec.examples,
    dependencies: spec.dependencies
  });
}

function applyStudioProfile(spec) {
  const profile = String(spec.studioProfile ?? spec.profile ?? "").toLowerCase();
  if (!profile) return spec;
  if (profile === "image-generation" || profile === "image-edit" || profile === "openai-image" || profile === "gemini-image") {
    const qualityDefault = profile === "openai-image" ? "high" : "2K";
    const modelDefault = profile === "openai-image" ? "gpt-image-1" : profile === "gemini-image" ? "gemini-3.1-flash-image-preview" : "";
    return {
      ...spec,
      category: spec.category ?? "Image Processing",
      inputs: spec.inputs ?? [{ id: "prompt", type: "text", required: false, label: "Prompt" }, { id: "images", type: "image", required: false, label: "Images" }],
      outputs: spec.outputs ?? [{ id: "image", type: "image", label: "Image" }, { id: "output", type: "json", label: "JSON" }],
      params: spec.params ?? [
        { id: "prompt", type: "text", label: "Prompt", default: spec.defaultPrompt ?? "Transform this into a polished, high-detail image." },
        { id: "model", type: "text", label: "Model", default: modelDefault },
        { id: "aspectRatio", type: "text", label: "Aspect Ratio", default: "1:1" },
        { id: "quality", type: "text", label: "Quality", default: qualityDefault }
      ],
      permissions: {
        network: true,
        networkHosts: profile === "openai-image" ? ["api.openai.com"] : profile === "gemini-image" ? ["generativelanguage.googleapis.com"] : [],
        readFiles: true,
        writeOutputs: true,
        shell: false,
        env: profile === "openai-image" ? ["OPENAI_API_KEY"] : profile === "gemini-image" ? ["GEMINI_API_KEY"] : [],
        ...(spec.permissions ?? {})
      },
      ui: mergeUi({
        params: {
          prompt: { control: "textarea", multiline: true },
          aspectRatio: { control: "select", options: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] },
          quality: { control: "select", options: profile === "openai-image" ? ["low", "medium", "high", "auto"] : ["1K", "2K", "4K"] }
        }
      }, spec.ui)
    };
  }
  if (profile === "text-generation" || profile === "llm") {
    return {
      ...spec,
      category: spec.category ?? "Text",
      inputs: spec.inputs ?? [{ id: "prompt", type: "text", required: false, label: "Prompt" }, { id: "systemPrompt", type: "text", required: false, label: "System" }],
      outputs: spec.outputs ?? [{ id: "text", type: "text", label: "Text" }, { id: "output", type: "json", label: "JSON" }],
      params: spec.params ?? [
        { id: "systemPrompt", type: "text", label: "System Prompt", default: "" },
        { id: "prompt", type: "text", label: "Prompt", default: "" },
        { id: "model", type: "text", label: "Model", default: spec.defaultModel ?? "" },
        { id: "temperature", type: "number", label: "Temperature", default: 0.7 },
        { id: "maxTokens", type: "number", label: "Max Tokens", default: 1024 }
      ],
      ui: mergeUi({
        params: {
          systemPrompt: { control: "textarea", multiline: true },
          prompt: { control: "textarea", multiline: true }
        }
      }, spec.ui)
    };
  }
  return spec;
}

function defaultIconForSpec(spec) {
  const profile = String(spec.studioProfile ?? spec.profile ?? "").toLowerCase();
  const text = [
    profile,
    spec.title,
    spec.name,
    spec.description,
    spec.category,
    spec.behavior,
    ...(Array.isArray(spec.tags) ? spec.tags : [])
  ].filter(Boolean).join(" ").toLowerCase();
  const outputTypes = new Set(Array.isArray(spec.outputs) ? spec.outputs.map((output) => output?.type).filter(Boolean) : []);
  const inputTypes = new Set(Array.isArray(spec.inputs) ? spec.inputs.map((input) => input?.type).filter(Boolean) : []);

  if (profile.includes("image") || outputTypes.has("image") || /\b(image|photo|picture|visual|generate art|edit image)\b/.test(text)) return "image";
  if (outputTypes.has("video") || inputTypes.has("video") || /\b(video|movie|animation|animate)\b/.test(text)) return "video";
  if (/\b(upscale|enhance|restore|retouch|transform)\b/.test(text)) return "wand";
  if (profile.includes("text") || profile === "llm" || outputTypes.has("text") || /\b(text|prompt|llm|chat|language|summarize|translate)\b/.test(text)) return "type";
  if (/\b(http|api|webhook|request|endpoint|network|fetch)\b/.test(text)) return "globe";
  if (outputTypes.has("file") || inputTypes.has("file") || /\b(file|document|pdf|csv|jsonl|export)\b/.test(text)) return "file";
  if (outputTypes.has("json") || inputTypes.has("json") || /\b(json|data|schema|parse|extract)\b/.test(text)) return "braces";
  if (/\b(code|script|plugin|developer)\b/.test(text)) return "code";
  return "node";
}

function mergeUi(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  return {
    ...base,
    ...override,
    params: {
      ...(base.params ?? {}),
      ...(override.params ?? {})
    }
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
  if (manifest.params !== undefined) validatePorts(manifest.params, "params", issues);
  if (manifest.capabilities !== undefined) validateCapabilities(manifest.capabilities, issues);
  if (issues.length) throw new Error(`Invalid Boojum-compatible node manifest:\n${issues.join("\n")}`);
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
    if (value.response !== undefined && (!value.response || typeof value.response !== "object" || Array.isArray(value.response))) {
      issues.push("executor.response: response must be an object.");
    }
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

function validateCapabilities(value, issues) {
  if (!Array.isArray(value)) {
    issues.push("capabilities: capabilities must be an array.");
    return;
  }
  value.forEach((capability, index) => {
    if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
      issues.push(`capabilities.${index}: Capability must be an object.`);
      return;
    }
    const id = requiredString(capability.id, `capabilities.${index}.id`, issues);
    if (id && !NODE_ID_PATTERN.test(id)) issues.push(`capabilities.${index}.id: Capability id must use letters, numbers, dots, dashes, or underscores.`);
    if (capability.defaultParams !== undefined && (!capability.defaultParams || typeof capability.defaultParams !== "object" || Array.isArray(capability.defaultParams))) {
      issues.push(`capabilities.${index}.defaultParams: defaultParams must be an object.`);
    }
    if (capability.priority !== undefined && typeof capability.priority !== "number") issues.push(`capabilities.${index}.priority: priority must be a number.`);
  });
}

function validateFileSet(manifest, paths) {
  if (!paths.includes("manifest.json")) throw new Error("Package must include manifest.json.");
  if (paths.length > MAX_PACKAGE_FILE_COUNT) throw new Error(`Package has too many files. Limit is ${MAX_PACKAGE_FILE_COUNT}.`);
  for (const path of paths) safePackagePath(path);
  if (manifest.executor.type === "plugin" && !paths.includes(manifest.executor.entry)) {
    throw new Error(`Plugin package is missing executor file: ${manifest.executor.entry}`);
  }
}

function pluginExecutorCode(spec) {
  if (typeof spec.pluginCode === "string" && spec.pluginCode.trim()) return spec.pluginCode.endsWith("\n") ? spec.pluginCode : `${spec.pluginCode}\n`;
  if (isImageProfile(spec)) return imagePluginExecutorCode(spec);
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

function isImageProfile(spec) {
  const profile = String(spec.studioProfile ?? spec.profile ?? "").toLowerCase();
  if (["image-generation", "image-edit", "openai-image", "gemini-image"].includes(profile)) return true;
  return Array.isArray(spec.outputs) && spec.outputs.some((output) => output && typeof output === "object" && output.id === "image");
}

function imagePluginExecutorCode(spec) {
  return `export async function runNode(context) {
  const { inputs, params, env, logger } = context;
  logger.info("Running generated image node.");

  // Replace this scaffold with the provider call. Keep the final image in this
  // portable shape so Boojum Studio can render an inline preview:
  // { mimeType: "image/png", base64: "..." } OR { localPath: "..." } OR { url: "..." }.
  const image = {
    mimeType: "image/png",
    base64: "",
    filename: "generated.png"
  };

  return {
    outputs: {
      image,
      output: {
        image,
        inputs,
        params,
        allowedEnvKeys: Object.keys(env)
      }
    },
    metadata: {
      behavior: ${JSON.stringify(spec.behavior ?? "TODO: call the image provider and fill image.base64, image.localPath, or image.url.")}
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
  let totalSize = 0;
  for (const data of files.values()) totalSize += data.byteLength;
  if (totalSize > MAX_PACKAGE_BYTES) throw new Error(`Package is too large. Limit is ${MAX_PACKAGE_BYTES} bytes.`);
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

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function removeUndefined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
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

