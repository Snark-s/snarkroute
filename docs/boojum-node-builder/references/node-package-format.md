# Boojum Node Package Format

This reference is bundled so the skill can create `.snarknode` packages without a Boojum/SnarkRoute repository checkout.

## Package

A portable `.snarknode` file is a ZIP-compatible archive. It is not a JSON file with a renamed extension.

Required root file:

```text
manifest.json
```

Optional files:

```text
executor.ts
ui.schema.json
README.md
examples/example.route.json
assets/
```

Plugin packages must include the file named by `executor.entry`.

Package paths must be relative and must not escape the package root. Reject absolute paths, `..`, `.env`, `node_modules`, excessive file counts, and oversized packages.

## Manifest

Required fields:

- `kind: "snarkroute.node"`
- `schemaVersion`
- `id`
- `title`
- `version`
- `author.name`
- `license`
- `origin`
- `permissions`
- `executor`
- `inputs`
- `outputs`

Common optional fields:

- `category`
- `description`
- `source`
- `params`
- `capabilities`
- `ui`
- `icon`
- `tags`
- `homepage`
- `repository`
- `examples`
- `dependencies`

## Icon

Use `icon` to give Studio and node libraries a compact visual hint. Keep it a simple lowercase id, not an emoji or SVG blob.

Recommended ids:

- `image`: image generation, image editing, visual synthesis
- `wand`: enhancement, upscale, retouch, cleanup, transform
- `video`: video generation, animation, frame tools
- `type`: text, prompts, LLM, summarization, translation
- `globe`: HTTP/API/network/provider calls
- `file`: files, documents, import/export
- `braces`: JSON, structured data, parsing, extraction
- `code`: script, plugin, developer utility
- `node`: generic custom node fallback

If the user supplies an icon, preserve it. Otherwise choose the closest id from the node title, category, profile, ports, and behavior. For image profiles, default to `image`; for API-only utility nodes, default to `globe`.

Allowed `origin` values:

- `bundled`
- `local`
- `installed`
- `linked`
- `remote`
- `generated`

For generated packages, use `origin: "local"` unless a repository-specific helper requires another value.

## Permissions

Use this object shape:

```json
{
  "network": false,
  "networkHosts": [],
  "readFiles": false,
  "writeOutputs": false,
  "shell": false,
  "env": []
}
```

Only request permissions that the described behavior needs. `env` contains environment variable names, not secret values.

## Executors

Plugin executor:

```json
{
  "type": "plugin",
  "runtime": "node",
  "entry": "executor.ts"
}
```

Plugin modules export:

```js
export async function runNode(context) {
  return {
    outputs: {
      result: { ok: true }
    },
    metadata: {}
  };
}
```

The context includes `inputs`, `params`, filtered `env`, `permissions`, `assets.writeText`, `assets.writeJson`, `assets.writeBase64`, `logger.info`, `logger.warn`, `logger.error`, `run.id`, and `run.outputDirectory`.

Declarative executor:

```json
{
  "type": "declarative"
}
```

Declarative HTTP executor:

```json
{
  "type": "declarative.http",
  "method": "POST",
  "urlTemplate": "{{params.endpoint}}",
  "headersTemplate": { "Content-Type": "application/json" },
  "bodyMode": "json",
  "bodyTemplate": {},
  "response": { "mode": "json" }
}
```

## Ports And Params

`inputs`, `outputs`, and `params` are arrays. Every item needs at least:

```json
{ "id": "prompt", "type": "text" }
```

Useful optional fields include `label`, `description`, `required`, and `default`.

Use `ui.params` for Studio controls:

```json
{
  "params": {
    "prompt": { "control": "textarea", "multiline": true },
    "aspectRatio": { "control": "select", "options": ["1:1", "16:9"] },
    "quality": { "control": "select", "options": ["low", "medium", "high", "auto"] },
    "seed": { "control": "number" },
    "transparentBackground": { "control": "checkbox" }
  }
}
```

## Image Node Defaults

For image generation or image editing nodes, prefer:

- inputs: `prompt` as text and `images` as image when image references are needed
- outputs: `image` and `output`
- params: `prompt`, `model`, `aspectRatio`, and `quality`
- network permissions only when the executor calls an API
- provider API keys in `permissions.env`
- return preview-friendly image output, not an opaque JSON blob

The `image` output should be one of these shapes:

```json
{
  "mimeType": "image/png",
  "base64": "..."
}
```

```json
{
  "localPath": "data/assets/generated/example.png",
  "filename": "example.png"
}
```

```json
{
  "url": "https://example.com/generated.png"
}
```

For OpenAI-compatible image responses, normalize `b64_json` to the portable shape:

```js
const image = {
  mimeType: "image/png",
  base64: response.data?.[0]?.b64_json,
  filename: "generated.png"
};

return {
  outputs: {
    image,
    output: {
      image,
      provider: "openai",
      model
    }
  }
};
```

Do not return only `{ output: { image: { base64: "..." } } }` if the manifest declares an `image` output port. Fill the `image` output port directly so Studio can show an inline preview and connected image nodes receive the right value.

If exact provider endpoint details are unknown, create a valid scaffold with honest TODO comments instead of inventing behavior.

