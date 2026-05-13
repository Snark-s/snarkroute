# Refactor Changelog

## Added

- `apps/snarkroute`: new SnarkRoute Living Canvas shell on port 5174.
- `packages/core`: shared domain package for future Living Canvas types.
- `packages/core/src/living-canvas`: minimal `LivingNode`, `CandidateCard`, `InputLink`, `LivingContext`, `CandidateProvenance`, and `ToolAction` types.
- `start-boojumroute.bat`: explicit launcher for the preserved graph/tool lab.
- Root scripts: `start:snarkroute`, `start:boojumroute`, `dev:snarkroute`, and `dev:boojumroute`.
- Documentation for architecture, audit findings, Living Canvas, and BoojumRoute Lab.
- Product icon mapping in `docs/images/PRODUCT-ICON-MAPPING.md`.
- Focused server modules under `apps/server/src/routes`, `apps/server/src/services`, `apps/server/src/providers`, `apps/server/src/assets`, `apps/server/src/prompt-library`, `apps/server/src/node-packages`, `apps/server/src/execution`, and `apps/server/src/ledger`.
- Compatibility type aliases in `packages/core`: `BlockManifest = SnarkNodeManifest` and `BlockPackageManifest = SnarkNodePackageManifest`.

## Changed

- `apps/studio/index.html` title is now `BoojumRoute Lab`.
- Visible Studio text now prefers BoojumRoute-facing labels such as blocks, installed blocks, block package, and internal tool route where safe.
- `start-snarkroute.bat` now starts the new Living Canvas shell instead of the old Studio.
- `start-studio.bat` prints BoojumRoute Lab labels.
- `start-server.bat` builds OpenRouter and Gemini adapters before starting because the server imports them.
- SnarkRoute and BoojumRoute public app icons are copied into their app `public` folders.
- `apps/server/src/index.ts` is now bootstrap-only; Fastify construction moved to `app.ts`, listen startup moved to `server.ts`, and route/controller modules are separated from service/provider helpers.
- OpenRouter-specific server glue moved out of the root entrypoint into `apps/server/src/providers/openrouter.ts`.

## Preserved

- Existing Studio implementation remains in `apps/studio`.
- Existing API server remains in `apps/server`.
- Open Route Protocol files still use `nodes`, `edges`, `subroute`, and node manifests.
- API paths remain unchanged.
- Local browser storage keys remain unchanged to preserve saved Studio state.
- Installed `.snarknode` packages remain compatible.
- "Blocks" and "block packages" remain UI/product terminology only. Protocol fields, API paths, storage keys, and package formats continue to use node terminology.

## Deferred

- Splitting `apps/studio/src/main.tsx` into components and hooks.
- Moving provider manifest definitions out of the server.
- Renaming package folders or public route fields.
- Replacing internal `Node` TypeScript names with `Block` aliases.
- Deep icon/shortcut generation beyond Vite favicon/public assets.
