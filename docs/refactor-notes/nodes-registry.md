# Nodes Registry Refactor Plan

Status: staged plan after the first architecture cleanup pass.

`packages/nodes/src/index.ts` currently combines several responsibilities:

- public node and prompt-library types
- built-in node definitions
- built-in manifest derivation
- node runners
- prompt/resource library parsing
- HTTP request helpers
- local asset and image/Png transform helpers

Safe staged path:

1. Move public node/prompt/resource types into `packages/nodes/src/types.ts`, then re-export them from `index.ts`.
2. Move `builtInNodeDefinitions` into `packages/nodes/src/definitions.ts` after `NodeDefinition` no longer lives in `index.ts`.
3. Move manifest derivation helpers (`builtInNodeCategory`, `builtInPermissions`, `builtInInputs`, `builtInOutputs`, `builtInParams`, `builtInUi`) into `packages/nodes/src/manifests.ts`.
4. Split runners by category only after definitions/manifests are separated:
   - `runners/io.ts`
   - `runners/prompt.ts`
   - `runners/preview.ts`
   - `runners/http.ts`
   - `runners/local-image.ts`
5. Keep `index.ts` as the compatibility barrel and registration entrypoint.

Guardrails:

- Do not change built-in node ids, params, permissions, or output shapes without a protocol migration.
- Keep `.snarknode` package system exports stable.
- Run `corepack pnpm --filter @snarkroute/nodes test` and `corepack pnpm --filter @snarkroute/nodes build` after each stage.
