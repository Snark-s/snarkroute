# Studio Main Refactor Plan

Status: staged plan after the Studio `main.tsx` cleanup passes.

Latest cleanup run:

- Start of this run: `apps/studio/src/main.tsx` had 10,983 lines.
- After this run: `apps/studio/src/main.tsx` has 9,733 lines.
- Total reduction in this run: 1,250 lines.

Modules extracted so far:

- `apps/studio/src/shared/costFormatting.ts`
- `apps/studio/src/shared/mediaPreview.ts`
- `apps/studio/src/shared/apiClient.ts`
- `apps/studio/src/shared/navigation.ts`
- `apps/studio/src/features/model-catalog/ModelViews.tsx`
- `apps/studio/src/features/admin/AdminPanel.tsx`
- `apps/studio/src/features/admin/AdminRoutes.tsx`
- `apps/studio/src/features/billing/EconomicsPanel.tsx`
- `apps/studio/src/features/route-io/routeFlow.ts`

`apps/studio/src/main.tsx` still combines several responsibilities:

- BoojumRoute Lab app state and route execution controls
- React Flow canvas node rendering and connection menus
- node parameter editors and preview panels
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

- `RouteNodeCard` and `NodeInlineParams`: still too broad for one safe move because they share canvas callbacks, provider settings, prompt library state, model options, run controls, and preview handlers. Extract leaf sections first.
- Full `App` state machine: keep in `main.tsx` until route IO, node packages, prompt library, and settings panels are further separated. Moving it now would create a large prop bundle or a new global store.
- Full route serialization/persistence: `routeFlow.ts` now owns safe flow conversion helpers, but `flowToRoute` and compound serialization still depend on local catalog/port helpers. Extract only after port helpers are split cleanly.
- Node package management panel: UI and package install/delete actions are still intertwined with library metadata and canvas placement. Next safe step is extracting rows/cards and metadata helpers before the whole panel.

Next safe targets:

- Move library node metadata helpers into a node-packages feature module.
- Move prompt library filtering/cards into a prompt-library feature module.
- Split `NodeInlineParams` by node family only after shared value/media helpers are stable.
- Split route serialization after `getNodePorts` and manifest/port helpers are detached from node rendering.

Guardrails:

- Do not change route document shape, storage keys, `.snarknode` behavior, or exported route compatibility during extraction.
- Do not move runtime/editor-generated files into commits.
- Do not introduce global stores or wide prop plumbing just to move code.
- Keep each extraction behavior-preserving and verify with `corepack pnpm --filter @snarkroute/studio build`.
- After normal code changes, run `graphify update .` so `graphify-out/` stays current.
