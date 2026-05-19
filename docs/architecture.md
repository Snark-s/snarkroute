# Architecture

SnarkRoute is now split into two product interfaces over one shared engine/runtime.

## Product Split

SnarkRoute is the object/workspace layer and future creative Living Canvas. Its user-facing model is made of Artifacts, boards, versions/stacks, relations, local inputs, inherited context, libraries, and Actions. In this pass it is intentionally only a small shell in `apps/snarkroute`.

BoojumRoute is the process-authoring Tool Lab. It preserves the old working graph interface, route editor, provider wiring, installed node packages, prompt library, and execution controls. User-facing BoojumRoute language should prefer "block" and "tool route" where safe, while protocol and TypeScript internals still use `node` for compatibility.

In this architecture, Node is an umbrella term for a generic graph item. ArtifactNode and BlockNode are different node kinds. ArtifactNodes are user-facing creative objects on SnarkRoute boards and are not executable operations by themselves. BlockNodes are executable operations or process blocks. In BoojumRoute, most traditional route nodes are BlockNodes.

"Blocks" and "block packages" are UI/product terminology for BoojumRoute. The compatibility surface remains Open Route Protocol terminology: route files and server/API/storage internals continue to use `nodes`, `edges`, `subroute`, `nodePackage`, and `.snarknode`.

Actions are user-facing invocations of BlockNodes or Boojum routes. A Boojum compound route/block can be exposed in SnarkRoute as an action button on an Artifact card.

Boards and Routes are related but distinct. A Board is an editable visual workspace/composition containing artifacts, block nodes when shown explicitly, relations, layout, groups/comments, versions/stacks, action history, provenance, and selected libraries/imports. A Route is an executable graph/process.

## Layers

- Core Protocol: `packages/protocol` owns Open Route Protocol schemas, parsing, validation, import, and export.
- Runtime / Execution: `packages/executor` owns DAG execution, topological ordering, template resolution, compound routes, run logs, and local ledger summaries.
- Providers: `packages/adapters/*` owns provider-specific API clients and node runners for OpenRouter, Gemini, and Replicate.
- Libraries: `packages/nodes` owns built-in block manifests, installed package loading, node library manifests, prompt libraries, and package validation. Conceptually, a Library is a portable reusable collection that may contain or reference artifacts, blocks, routes, boards, prompt chips, styles, model presets, and assets.
- Data Storage: `packages/storage` owns local run storage. The server still owns some asset, prompt mutation, and ledger read helpers that should move later.
- Server API: `apps/server/src/app.ts` wires focused Fastify route modules. Controllers live under `apps/server/src/routes`, while provider glue, execution setup, node package helpers, asset helpers, prompt library mutation, and ledger helpers live in focused service/provider folders.
- Shared Engine: protocol, executor, adapters, nodes, and storage remain shared. Neither UI duplicates runtime logic.
- Studio UI / BoojumRoute Lab: `apps/studio` is the preserved graph editor, now branded as BoojumRoute Lab.
- SnarkRoute Living Canvas: `apps/snarkroute` is a new minimal shell with no provider calls yet.
- Future Domain: `packages/core/src/living-canvas` contains small TypeScript types for Living Canvas artifacts/nodes, candidate cards, inputs, provenance, context, and tool actions.

## Compatibility

Saved route files continue to use Open Route Protocol `nodes` and `edges`. Installed `.snarknode` manifests remain readable. API routes such as `/api/nodes` and `/api/node-packages/*` are unchanged in this pass.

The term `node` is intentionally left in internal code, storage keys, protocol types, and package formats until a documented protocol migration exists. `packages/core` exposes `BlockManifest` and `BlockPackageManifest` as type aliases only; they do not rename serialized fields.

See `docs/terminology.md` for the shared terminology model.
