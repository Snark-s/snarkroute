# Studio Main Refactor Plan

Status: staged plan after the first Studio `main.tsx` cleanup passes.

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

Guardrails:

- Do not change route document shape, storage keys, `.snarknode` behavior, or exported route compatibility during extraction.
- Do not move runtime/editor-generated files into commits.
- Do not introduce global stores or wide prop plumbing just to move code.
- Keep each extraction behavior-preserving and verify with `corepack pnpm --filter @snarkroute/studio build`.
- After normal code changes, run `graphify update .` so `graphify-out/` stays current.
