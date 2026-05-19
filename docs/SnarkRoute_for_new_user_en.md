# BoojumRoute Lab: Brief Guide For New Users

## What It Is

BoojumRoute Lab is an experimental graph environment for building AI pipelines from Blocks / BlockNodes. You can connect models, prompts, images, text transforms, and external services into routes that can be run, saved, and extended with custom block packages.

Instead of manually wiring API calls, scripts, and one-off steps, you assemble a process on a canvas. Blocks produce inputs, transform data, call providers, preview media, and save outputs. Connections show how data moves through the route.

Node is an umbrella term in the broader SnarkRoute model. In this BoojumRoute guide, traditional route nodes are executable BlockNodes, not SnarkRoute creative ArtifactNodes.

BoojumRoute Lab is local-first. You can build, save, restore, run, import, export, and extend routes with installed node packages.

## What You Can Do Now

### Visual Canvas

You can add blocks, move them around the canvas, connect outputs to compatible inputs, delete blocks and edges, run a route, and inspect logs, results, and previews.

### Node Palette

The Studio has a node/block palette grouped by categories. Blocks can be added by clicking or dragging. BoojumRoute Lab includes bundled blocks and can also use installed local block packages.

### Compatible Node Insertion

You can drag from a node output to an empty canvas area. Studio shows compatible nodes, then adds and connects the selected node automatically.

### Save And Restore

Studio saves the current route to browser localStorage and can restore it on reload. This is local browser storage, not full server-side project storage.

### Import And Export

Routes can be imported, exported, or dropped onto the canvas. Supported route formats include `.orp`, `.orp.json`, `.orp.yaml`, `.route`, `.route.json`, `.route.yaml`, and plain JSON/YAML.

### Installed Nodes

Studio can install node packages from a file, local path, URL, or node library. Installed blocks can be enabled, disabled, inspected through README, and uninstalled. Bundled blocks cannot be removed.

### Missing Nodes

If a route references a node that is not installed or is disabled, Studio preserves the node and shows it as a missing-node placeholder. This keeps route files portable instead of destroying unknown parts of the graph.

### Compound And Subroute Nodes

Selected blocks can be collapsed into a compound node with an internal subroute. You can open the subroute, edit it, go back to the parent route, execute the compound node, or uncollapse it back into individual blocks.

### Execution

The execution engine follows graph dependencies, detects cycles, resolves templates such as `{{nodeId.output.path}}`, executes compound subroutes, collects logs/results/provenance, records cost metadata, and saves run results locally.

### Backend API

The backend provides APIs for health checks, settings and API tokens, node catalogs, node package installation, route validation, route execution, run history/ledger, prompt library access, assets, and provider helpers.

## Main Project Areas

| Folder | Responsibility |
|---|---|
| `apps/studio` | Studio UI, canvas, palette, context menus, save/load |
| `apps/server` | Fastify backend API |
| `packages/protocol` | Route format, import/export, validation |
| `packages/executor` | Execution engine |
| `packages/nodes` | Built-in blocks and node package system |
| `packages/adapters` | External provider adapters |
| `examples` | Example routes and custom nodes |
| `docs` | Project documentation |

## Good First Demos

### Basic Route

Add `Text Input`, connect it to `Template Transform` or `Debug Log`, run the route, and inspect logs/results. This demonstrates the canvas, typed connections, execution, and local result display.

### Installed Node

Install a custom node from `examples/custom-nodes`, add it to the canvas, validate or run the route, then disable or uninstall it. This demonstrates the node package system and missing-node placeholders.

### Compound Route

Build a small chain, select part of it, collapse it into a compound node, open the subroute, edit it, go back, run the parent route, and uncollapse it. This demonstrates nested graph editing and execution.

## Current Limitations

- The palette has categories but no full search yet.
- Dirty state is tracked, but there is no persistent visible dirty indicator.
- Compound port editing is still rough and uses browser prompts.
- Generic `declarative` executor support is unclear; `declarative.http` is implemented.
- Provider demos require external provider tokens or a local Stable Diffusion endpoint.
- Studio save/load currently uses browser localStorage rather than server-side project storage.
- Visual clarity should still be checked in a live browser before demos.

## Short Version

BoojumRoute Lab is a route laboratory: build a process from Blocks, run it, inspect what happened, extend it with your own block packages, and gradually turn scattered AI tools and local processes into a manageable visual pipeline.
