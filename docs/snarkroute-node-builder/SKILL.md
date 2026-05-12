---
name: snarkroute-node-builder
description: Create ready-to-import SnarkRoute .snarknode ZIP packages from text descriptions, including manifest validation, filesystem-safe names, protocol-safe ids, plugin executor files, declarative nodes, permissions, README/examples, and a bundled standalone Node.js generator that works outside the SnarkRoute repository.
---

# SnarkRoute Node Builder

Use this skill when the user asks to create a ready-to-import SnarkRoute node package from a text description.

## Ground Truth

- This skill must work for any user, including users who do not have the SnarkRoute repository checked out. Treat the bundled files in this skill as the primary fallback source of truth.
- Follow the SnarkRoute node package model summarized in `references/node-package-format.md`: `kind`, `schemaVersion`, `id`, `title`, `version`, `author`, `license`, `origin`, `permissions`, `executor`, `inputs`, `outputs`, optional `params`, and optional metadata such as `capabilities`, `ui`, `icon`, `tags`, `homepage`, `repository`, `examples`, and `dependencies`.
- A portable `<name>.snarknode` is a ZIP archive, not a JSON file with a renamed extension.
- The ZIP root must contain `manifest.json`.
- Plugin packages must include the file named by `executor.entry`.
- Inside a SnarkRoute repository, prefer existing validation and packing helpers if they are present: `validateNodeManifest`, `packNodePackage`, and `previewNodePackageArchive`.
- Outside the repository, use the bundled standalone generator. It mirrors the current manifest validation rules and creates ZIP-compatible `.snarknode` packages with no external dependencies.
- A good node is not just valid. It should be Studio-ready: clear `category`, meaningful port labels, useful `params` with defaults, and `ui.params` controls for text areas, selects, checkboxes, and numeric fields.
- Do not invent protocol fields or endpoint behavior.
- Keep route/package files portable across SnarkRoute tools.

## Context Discovery

Use this order. Stop as soon as you have enough information to generate and validate the package.

1. Read this skill's bundled reference at `references/node-package-format.md`.
2. For API/provider nodes, read `references/provider-connections.md` and decide whether the needed provider connection already exists in the user's SnarkRoute checkout.
3. Use the bundled generator at `scripts/create-snarknode.mjs`; it is the portable implementation and should work without a repo checkout.
4. If the current workspace looks like SnarkRoute, inspect only the smallest relevant package files:
   - `packages/nodes/src/package-system.ts`
   - `scripts/create-snarknode.ts`
   - `examples/custom-nodes/*/manifest.json` or `examples/custom-nodes/*.snarknode/manifest.json` when an example is directly relevant
   - `docs/node-packages.md` or `docs/node-package-format.md` only if local docs exist and are needed
5. If those paths are absent, do not keep widening the search. Continue from the bundled references and generator.
6. Never depend on repository-specific docs such as `docs/skills/context-budget.md`; those are project operating instructions, not node package format requirements.
7. If provider/API details are requested and are not bundled here, either use official current documentation when browsing is available, or generate an honest scaffold with TODOs and explicit env placeholders. Do not fake an endpoint.

## API Provider Connections

When a node calls an external API, handle the connection before packaging the node.

1. Identify the provider, host, env key, and whether the node can route through an existing provider connection.
2. In a SnarkRoute checkout, inspect only the local provider/settings surface:
   - `apps/studio/src/main.tsx` for the right-column Settings UI and configured-state checks.
   - `apps/server/src/index.ts` for `/api/settings` and provider key endpoints.
   - `data/provider-links.json` when provider help links are needed and the file exists.
3. Reuse an existing connection when it matches the provider:
   - OpenRouter: `OPENROUTER_API_KEY`, `openrouter.ai`, primary remote provider.
   - Gemini: `GEMINI_API_KEY`, `generativelanguage.googleapis.com`, direct advanced provider.
   - Replicate: `REPLICATE_API_TOKEN`, `api.replicate.com`, direct advanced provider.
4. If the provider is missing and the user asked for a working SnarkRoute integration, add the provider connection using the same local pattern:
   - server status in `GET /api/settings`;
   - server save endpoint under `/api/settings/<provider>`;
   - env persistence through the existing env writer;
   - in-process `process.env.<KEY>` update after save;
   - right-column Settings card or Advanced/Direct section;
   - configured-state text and "Configure" hints on relevant nodes when applicable;
   - provider links when the repository has a provider-links registry.
5. If the task is only to create a portable `.snarknode` package and the app cannot be edited, declare the required env key in `permissions.env`, include the network host in `permissions.networkHosts`, and mention the required connection in the README. Do not embed secrets in the package.
6. For OpenAI direct API nodes, use the direct OpenAI connection when it exists. Use OpenRouter only when the requested model/endpoint is actually available through OpenRouter; otherwise require/add a direct `OPENAI_API_KEY` connection for `api.openai.com`.

## Workflow

1. Convert the user's description into a `CreateSnarkNodeSpec`.
2. Choose a filesystem-safe slug. Example: `My Cool Node` -> `my-cool-node.snarknode`.
3. Choose a protocol-safe node id. Prefer the user-provided id; otherwise use `custom.<slug>`.
4. Keep `author` as an object, usually `{ "name": "..." }`.
5. Keep `permissions` as an object with `network`, `networkHosts`, `readFiles`, `writeOutputs`, `shell`, and `env`.
6. Keep `inputs`, `outputs`, and `params` as arrays.
7. Always create useful `params` for values users should edit in Studio. Do not hide normal controls only inside code.
8. Pick a suitable `icon` when the user did not provide one. Use the icon ids in `references/node-package-format.md`.
9. Use `ui.params.<paramId>` for better controls:
   - `{ "control": "textarea", "multiline": true }` for prompts or JSON-like bodies.
   - `{ "control": "select", "options": ["1:1", "16:9"] }` for known option sets.
   - `{ "control": "number" }` for numeric values.
   - `{ "control": "checkbox" }` for booleans.
10. For plugin nodes, generate `executor.ts` with `export async function runNode(context)`.
11. For declarative nodes, do not add runtime code.
12. Run the bundled standalone generator, which validates the manifest, zips the package contents, and writes `<slug>.snarknode`.

## Standalone Generator

Create a JSON spec and run:

```bash
node path/to/snarkroute-node-builder/scripts/create-snarknode.mjs path/to/spec.json path/to/output-folder
```

The generated artifact appears at:

```text
path/to/output-folder/<slug>.snarknode
```

The helper script is:

```text
scripts/create-snarknode.mjs
```

The generator is bundled with this skill and uses only built-in Node.js modules. It does not require a SnarkRoute repository checkout, pnpm, or `@snarkroute/nodes`.

When this skill is installed in Codex, the script is normally available at:

```text
~/.codex/skills/snarkroute-node-builder/scripts/create-snarknode.mjs
```

## Spec Fields

- `name` or `slug`
- `id`
- `title`
- `description`
- `category`
- `version`
- `author`
- `license`
- `source`
- `inputs`
- `outputs`
- `params`
- `capabilities`
- `ui`
- `icon`
- `tags`
- `homepage`
- `repository`
- `examples`
- `dependencies`
- `studioProfile` or `profile`: optional helper preset, currently `image-generation`, `image-edit`, `openai-image`, `gemini-image`, `text-generation`, or `llm`
- `permissions`
- `executorType`: `declarative`, `declarative.http`, or `plugin`
- `executor`
- `runtime`
- `behavior`
- `generatePluginCode`
- `declarative`
- `includeReadme`
- `includeExamples`
- `pluginCode`

## Studio Quality Rules

- Prefer labels users understand: `Prompt`, `Images`, `Aspect Ratio`, `Quality`, not only protocol ids.
- Choose an icon that communicates the node's job at a glance. Prefer `image` for image generation/editing, `wand` for enhancement/upscale/transform, `type` for text/LLM, `globe` for HTTP/API, `video` for video, `file` for file/document work, `braces` for JSON/data, and `code` for developer/script nodes.
- Add editable params for common runtime choices. For image nodes, include `prompt`, `aspectRatio`, and `quality` unless the user asks otherwise.
- For API/provider nodes, first check provider connections as described above, then list required env keys in `permissions.env`; the Studio generic renderer will show them as required env hints.
- For image nodes, return the image on the `image` output port in a Studio-previewable shape: `{ "mimeType": "image/png", "base64": "..." }`, `{ "localPath": "..." }`, or `{ "url": "..." }`. Put richer provider metadata on `output`, but do not make Studio fish the actual image out of arbitrary nested JSON.
- For known option sets, use `ui.params` select controls so custom nodes feel closer to bundled nodes.
- If behavior needs a secret token, never put it in params or README examples. Use `permissions.env`.
- Do not generate fake API behavior. If official endpoint details are missing, generate a scaffold with honest TODOs.

## Minimal Declarative Example

```json
{
  "name": "My Cool Node",
  "title": "My Cool Node",
  "author": { "name": "Your Name" },
  "executorType": "declarative",
  "inputs": [{ "id": "input", "type": "text", "required": false }],
  "outputs": [{ "id": "result", "type": "json" }],
  "params": []
}
```

This produces `my-cool-node.snarknode` as a real ZIP archive containing `manifest.json`.

## Plugin Example

```json
{
  "slug": "prompt-length",
  "title": "Prompt Length",
  "description": "Returns the length of a prompt.",
  "category": "Text",
  "author": { "name": "Your Name" },
  "executorType": "plugin",
  "studioProfile": "image-generation",
  "inputs": [{ "id": "prompt", "type": "text", "required": true, "label": "Prompt" }],
  "outputs": [{ "id": "result", "type": "json", "label": "Result" }],
  "params": [],
  "permissions": {
    "network": false,
    "networkHosts": [],
    "readFiles": false,
    "writeOutputs": false,
    "shell": false,
    "env": []
  },
  "ui": {
    "params": {
      "prompt": { "control": "textarea", "multiline": true },
      "quality": { "control": "select", "options": ["low", "medium", "high", "auto"] }
    }
  },
  "pluginCode": "export async function runNode(context) {\n  const prompt = String(context.inputs.prompt ?? \"\");\n  return { outputs: { result: { length: prompt.length } } };\n}\n",
  "includeExamples": true
}
```

Do not request `shell`, `network`, `readFiles`, or `writeOutputs` unless the described behavior explicitly needs them. If an environment variable is needed, list only its name in `permissions.env`; never hardcode secrets.

## Declarative HTTP Example

```json
{
  "slug": "placeholder-api-call",
  "title": "Placeholder API Call",
  "author": { "name": "Your Name" },
  "executorType": "declarative.http",
  "permissions": {
    "network": true,
    "networkHosts": ["api.example.com"],
    "readFiles": false,
    "writeOutputs": false,
    "shell": false,
    "env": []
  },
  "executor": {
    "method": "POST",
    "urlTemplate": "{{params.endpoint}}",
    "headersTemplate": { "Content-Type": "application/json" },
    "bodyMode": "json",
    "bodyTemplate": { "prompt": "{{inputs.prompt}}" },
    "response": {
      "mode": "json",
      "mappings": { "text": "$.result.text" }
    }
  },
  "inputs": [{ "id": "prompt", "type": "text", "required": true }],
  "outputs": [{ "id": "text", "type": "text" }],
  "params": [{ "id": "endpoint", "type": "text", "default": "https://api.example.com/replace-me" }]
}
```

Use honest placeholders for user-provided endpoints or tokens. Do not pretend an external endpoint exists.

## Verification

Run:

```bash
node ~/.codex/skills/snarkroute-node-builder/scripts/create-snarknode.mjs spec.json ./out
```

Inside the SnarkRoute repository, also run:

```bash
pnpm create-snarknode:test
pnpm --filter @snarkroute/nodes test
```
