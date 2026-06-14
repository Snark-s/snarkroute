# Studio Main Refactor Plan

Status: staged plan after the Studio `main.tsx` cleanup passes.

Latest cleanup run:

- Start of the previous broad cleanup run: `apps/studio/src/main.tsx` had 10,983 lines.
- Start of the node-params split run: `apps/studio/src/main.tsx` was measured at 9,733 lines.
- After the node-params split run: `apps/studio/src/main.tsx` has 9,642 lines.
- Total reduction since the 11,479-line baseline: 1,837 lines.

Modules extracted so far:

- `apps/studio/src/shared/costFormatting.ts`
- `apps/studio/src/shared/mediaPreview.ts`
- `apps/studio/src/shared/apiClient.ts`
- `apps/studio/src/shared/navigation.ts`
- `apps/studio/src/shared/fileHelpers.ts`
- `apps/studio/src/features/model-catalog/ModelViews.tsx`
- `apps/studio/src/features/admin/AdminPanel.tsx`
- `apps/studio/src/features/admin/AdminRoutes.tsx`
- `apps/studio/src/features/billing/EconomicsPanel.tsx`
- `apps/studio/src/features/route-io/routeFlow.ts`
- `apps/studio/src/features/node-params/ParamRows.tsx`
- `apps/studio/src/features/node-params/paramHelpers.ts`
- `apps/studio/src/features/node-params/AssetNodeParams.tsx`
- `apps/studio/src/features/node-params/TextNodeParams.tsx`
- `apps/studio/src/features/node-params/HttpRequestParams.tsx`
- `apps/studio/src/features/node-params/TransformNodeParams.tsx`
- `apps/studio/src/features/prompt-library/PromptLibraryNodeParams.tsx`
- `apps/studio/src/features/canvas-node/RouteNodeActions.tsx`
- `apps/studio/src/features/canvas-node/RouteNodePreview.tsx`
- `apps/studio/src/features/node-packages/nodePackageHelpers.ts`

`apps/studio/src/main.tsx` still combines several responsibilities:

- BoojumRoute Lab app state and route execution controls
- React Flow canvas node rendering and connection menus
- provider-heavy node parameter editors and preview panels
- dialogue workbench UI
- provider settings, billing, and admin panels
- route import/export and local asset previews
- formatting and small presentational helpers

Safe staged path:

1. Keep extracting pure helpers first:
   - route conversion and import/export helpers
   - media preview helpers
   - output and cost formatting helpers
2. Extract small presentational components only when their props are already stable and local:
   - model catalog badges/logos
   - compact panels and list rows
   - read-only previews
3. Move feature-sized panels after their helper dependencies are already separated:
   - model catalog controls
   - billing/admin panels
   - provider settings panels
   - dialogue workbench views
4. Leave the central `App` state machine in place until surrounding components stop depending on broad shared closure state.

Deferred sections:

- `NodeInlineParams`: shared primitives, prompt-library params, asset params, text/output params, HTTP params, and transform params are now extracted. Remaining provider families (`ai.text`, Polza, Gemini, local Stable Diffusion, Replicate clarity/model) still share model catalogs, pricing badges, connected input state, provider configuration, and model logo behavior. Extract them family-by-family; do not move the whole dispatcher unless the provider props stay compact.
- `RouteNodeCard`: run actions and collapsed image preview are extracted. The header, ports, provider token status blocks, inline params mount, and React Flow handles remain because moving them together would create a broad prop surface and risks canvas/handle behavior.
- Full `App` state machine: keep in `main.tsx` until route IO, node packages, prompt library, and settings panels are further separated. Moving it now would create a large prop bundle or a new global store.
- Full route serialization/persistence: `routeFlow.ts` now owns safe flow conversion helpers, but `flowToRoute` and compound serialization still depend on local catalog/port helpers. Extract only after port helpers are split cleanly.
- Node package management panel: metadata helpers are extracted. The panel UI and package install/delete actions remain intertwined with preview selection, install state, route placement, and context menu behavior. Next safe step is rows/cards/actions, not the whole panel.
- Prompt library panel/context menu: node-parameter selection UI is extracted. Full panel/context-menu behavior remains in `main.tsx` because update/delete/move actions retarget route nodes and share App state.

Next safe targets:

- Extract provider-family node params in small chunks, starting with the least stateful provider branch.
- Extract node package rows/cards/actions after stabilizing their callback surface.
- Extract prompt library context-menu or asset draft rows only if route-node retargeting can stay in `main.tsx`.
- Split `RouteNodeCard` ports/header only after port helpers and node icon helpers are detached from `main.tsx`.
- Split route serialization after `getNodePorts` and manifest/port helpers are detached from node rendering.

Guardrails:

- Do not change route document shape, storage keys, `.snarknode` behavior, or exported route compatibility during extraction.
- Do not move runtime/editor-generated files into commits.
- Do not introduce global stores or wide prop plumbing just to move code.
- Keep each extraction behavior-preserving and verify with `corepack pnpm --filter @snarkroute/studio build`.
- After normal code changes, run `graphify update .` so `graphify-out/` stays current.
