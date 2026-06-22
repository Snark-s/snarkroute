# Agent Context Index

This file is a lookup map for Codex. It is not required reading for every task.

Use it only to choose the smallest relevant area before inspecting files. Follow
`docs/skills/context-budget.md`: do not scan the whole repository by default,
avoid unrelated source, and prefer focused checks.

## 1. Route/protocol format tasks

Likely areas:

- `packages/protocol`
- `packages/core`
- `examples`
- `docs/open-route-protocol.md`
- `docs/open-route-protocol-v0.1.md`
- `docs/economics-v0.1.md`

Look for route schemas, validation, parsing, compatibility rules, provenance,
economics metadata, and portable `.orp`, `.orp.yaml`, `.orp.json`,
`.route.yaml`, or `.route.json` examples.

Do not change route formats or storage keys without an explicit migration
decision and focused example/validation updates.

## 2. Execution/runtime tasks

Likely areas:

- `packages/executor`
- `packages/core`
- `packages/protocol`
- `packages/storage`
- `apps/server/src/execution`
- `apps/server/src/routes/execution.ts`

Look for route execution, runtime orchestration, dependency ordering, run
results, asset persistence, logs, and focused execution tests.

## 3. Server/API route tasks

Likely areas:

- `apps/server`
- `packages/storage`
- `packages/protocol`
- `packages/executor`

Look for API route registration, request validation, local asset previews,
settings, run/result endpoints, environment handling, auth adapters, and
server-side service boundaries.

## 4. Provider/model gateway/pricing tasks

Likely areas:

- `packages/adapters`
- `packages/model-registry`
- `apps/server/src/providers`
- `apps/server/src/billing`
- `docs/model-registry-principles.md`
- `docs/model-gateway-v0.md`
- `docs/model-gateway-audit.md`
- `docs/seedance-provider-settings.md`
- `docs/economics-v0.1.md`

Look for provider-specific adapter behavior, model registry data, gateway
routing, credential handling, usage events, pricing metadata, and billing
summaries. Keep provider-specific behavior in adapter/provider layers.

## 5. BoojumRoute Studio UI tasks

Likely areas:

- `apps/studio`
- `packages/nodes`
- `packages/protocol`
- `docs/BOOJUMROUTE-LAB.md`
- `docs/node-palette.md`

Look for React Flow editing, node palette behavior, node panels, route editing,
previews, import/export UI, and Studio-specific user workflows.

## 6. SnarkRoute Living Canvas tasks

Likely areas:

- `apps/snarkroute`
- `packages/core`
- `docs/SNARKROUTE-LIVING-CANVAS.md`
- `docs/architecture.md`

Look for Living Canvas shell behavior, shared domain primitives, canvas
interaction concepts, and experimental SnarkRoute UI flow.

## 7. Node package / .snarknode tasks

Likely areas:

- `packages/nodes`
- `packages/protocol`
- `docs/node-package-format.md`
- `docs/node-packages.md`
- `docs/node-library-manifest.md`
- `docs/custom-nodes.md`
- `docs/security/external-node-packages.md`
- `docs/boojum-node-builder`

Look for built-in node manifests, node execution helpers, declarative package
formats, explicit permissions, `.snarknode` packaging, and node-library
metadata.

Do not execute arbitrary plugin or community JavaScript code.

## 8. Prompt library / asset tasks

Likely areas:

- `docs/prompt-library.md`
- `docs/assets.md`
- `docs/export.md`
- `docs/node-palette.md`
- `packages/protocol`
- `packages/executor`
- `packages/storage`
- `apps/server`

Look for prompt assets, asset references, asset sources, resolver/export rules,
local previews, persistence, and route-portable asset metadata.

## 9. Billing/cloud-dev tasks

Likely areas:

- `apps/server/src/billing`
- `apps/server/src/auth`
- `apps/server/src/services`
- `packages/storage`
- `docs/boojum-billing-design.md`
- `docs/boojum-cloud-dev.md`
- `docs/cloud-dev-status.md`
- `docs/boojum-auth-smoke-checklist.md`

Look for auth adapters, billing adapters, run credit accounting, cloud storage,
environment configuration, and smoke-check documentation.

Do not add payments, marketplace features, user accounts, or cloud assumptions
unless the task explicitly asks for them.

## 10. Docs-only tasks

Likely areas:

- The specific `docs` file named by the task
- Nearby docs only when needed to avoid stale or conflicting guidance
- `examples` only when documentation claims need route-format verification

Do not inspect application source unless the documentation task requires
verification. Do not edit `README` unless the user explicitly asks.

## 11. Files/folders to avoid by default

Avoid by default:

- `archive`
- `generated`
- `temp`
- `.tmp`
- `.codex-dev-logs`
- `.codex-smoke`
- `dist`
- `build`
- `node_modules`
- `graphify-out` raw reports, except scoped `graphify query/path/explain`
- old reports
- logs
- large output folders

Read these only when the user explicitly asks or when the narrow task cannot be
completed without them. Explain why any extra files were inspected.
