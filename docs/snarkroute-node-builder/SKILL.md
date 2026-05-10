---
name: snarkroute-node-builder
description: Create ready-to-import SnarkRoute .snarknode ZIP packages from text descriptions, including manifest validation, filesystem-safe names, protocol-safe ids, plugin executor files, declarative nodes, permissions, README/examples, and a bundled standalone Node.js generator that works outside the SnarkRoute repository.
---

# SnarkRoute Node Builder

Use this skill when the user asks to create a ready-to-import SnarkRoute node package from a text description.

## Ground Truth

- Follow the current SnarkRoute node package model in `packages/nodes/src/package-system.ts`: `kind`, `schemaVersion`, `id`, `title`, `version`, `author`, `license`, `origin`, `permissions`, `executor`, `inputs`, `outputs`, optional `params`, and optional metadata such as `capabilities`, `ui`, `icon`, `tags`, `homepage`, `repository`, `examples`, and `dependencies`.
- A portable `<name>.snarknode` is a ZIP archive, not a JSON file with a renamed extension.
- The ZIP root must contain `manifest.json`.
- Plugin packages must include the file named by `executor.entry`.
- Inside the SnarkRoute repository, use existing validation and packing helpers: `validateNodeManifest`, `packNodePackage`, and `previewNodePackageArchive`.
- Outside the repository, use the bundled standalone generator. It mirrors the current manifest validation rules and creates ZIP-compatible `.snarknode` packages with no external dependencies.
- A good node is not just valid. It should be Studio-ready: clear `category`, meaningful port labels, useful `params` with defaults, and `ui.params` controls for text areas, selects, checkboxes, and numeric fields.
- Do not invent protocol fields or endpoint behavior.
- Keep route/package files portable across SnarkRoute tools.

## Workflow

1. Convert the user's description into a `CreateSnarkNodeSpec`.
2. Choose a filesystem-safe slug. Example: `My Cool Node` -> `my-cool-node.snarknode`.
3. Choose a protocol-safe node id. Prefer the user-provided id; otherwise use `custom.<slug>`.
4. Keep `author` as an object, usually `{ "name": "..." }`.
5. Keep `permissions` as an object with `network`, `networkHosts`, `readFiles`, `writeOutputs`, `shell`, and `env`.
6. Keep `inputs`, `outputs`, and `params` as arrays.
7. Always create useful `params` for values users should edit in Studio. Do not hide normal controls only inside code.
8. Use `ui.params.<paramId>` for better controls:
   - `{ "control": "textarea", "multiline": true }` for prompts or JSON-like bodies.
   - `{ "control": "select", "options": ["1:1", "16:9"] }` for known option sets.
   - `{ "control": "number" }` for numeric values.
   - `{ "control": "checkbox" }` for booleans.
9. For plugin nodes, generate `executor.ts` with `export async function runNode(context)`.
10. For declarative nodes, do not add runtime code.
11. Run the bundled standalone generator, which validates the manifest, zips the package contents, and writes `<slug>.snarknode`.

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
- Add editable params for common runtime choices. For image nodes, include `prompt`, `aspectRatio`, and `quality` unless the user asks otherwise.
- For API/provider nodes, list required env keys in `permissions.env`; the Studio generic renderer will show them as required env hints.
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
