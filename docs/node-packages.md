# SnarkRoute Node Packages

SnarkRoute keeps the `.snarknode` package name and manifest fields for compatibility. Conceptually, these packages install BoojumRoute Blocks: executable BlockNodes or tools that can be used inside routes.

Bundled blocks are not a special technical caste. They are node manifests with:

- `origin: "bundled"`
- `source: "snarkroute-core"`
- author, version, license, permissions, executor, inputs, outputs, and optional params

## Package Layout

During development a `.snarknode` can be a folder:

```text
my-node.snarknode/
  manifest.json
  executor.ts
  ui.schema.json
  README.md
  examples/
    example.route.json
```

Portable `.snarknode` files are zip-compatible archives with the same root structure. They can be imported from the file picker, dropped onto the canvas, installed from URL, or referenced by node-library manifests.

Node is an umbrella term in the broader product model. This document is about executable BlockNodes and the legacy package format; it does not describe SnarkRoute Artifacts such as images, prompts, masks, references, or generated outputs.

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

Plugin executors use:

```json
{
  "executor": {
    "type": "plugin",
    "runtime": "node",
    "entry": "executor.ts"
  }
}
```

Declarative nodes use:

```json
{
  "executor": {
    "type": "declarative"
  }
}
```

## Plugin Executor Contract

Plugin modules export `runNode(context)`.

The context includes:

- `inputs`
- `params`
- `env`, filtered to only names listed in `permissions.env`
- `permissions`
- `assets.writeText`, `assets.writeJson`, `assets.writeBase64`
- `logger.info`, `logger.warn`, `logger.error`
- `run.id`
- `run.outputDirectory`

Return:

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

Plugin blocks do not receive all environment variables. Shell execution is refused in this build even if requested.

## Packing

```bash
pnpm snarknode:pack examples/custom-nodes/plugin-env-echo.snarknode
```

The packer validates the manifest, checks executor files, skips `.env` and `node_modules`, and writes a portable `.snarknode` archive.

## Local Installation

Installed block packages live in:

```text
data/installed-nodes/
  node.id/
    manifest.json
    executor.ts
```

Routes reference node ids and params for compatibility. They do not embed executor code or secrets.

## Uninstalling

Studio's Manage Installed Nodes area can remove imported local block/node packages from `data/installed-nodes/`.

Bundled/core blocks have `origin: "bundled"` and cannot be removed.

If the current route uses a node being deleted, Studio warns first. Confirming the uninstall removes the package but preserves route and canvas data. Existing instances are then shown as missing-node placeholders by the normal missing-node validation path.

## Missing Nodes

If a route references a node id that is neither bundled nor installed, validation returns:

```text
This route uses node "X", but it is not installed. Install the node package or remove this node.
```

Studio preserves the missing block node and its connections.

## Libraries

A node library manifest lists installable block/node URLs. Loading a library previews the list; SnarkRoute installs only the blocks selected by the user. In the broader terminology, libraries may also contain or reference artifacts, routes, boards, prompt chips, styles, model presets, and assets.
