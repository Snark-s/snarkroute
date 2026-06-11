# Studio Agent Instructions

`apps/studio/src/main.tsx` is large and fragile. Treat changes here as
stabilization work unless the user explicitly asks for new behavior.

## Working Rules

- Prefer mechanical extraction over behavior changes.
- Keep behavior-preserving moves separate from feature work.
- Do not mix UI refactors with provider, model, pricing, or catalog changes.
- Do not mix route/flow conversion changes with visual component changes.
- Do not move `App` state, refs, effects, or handler ownership unless explicitly
  requested.
- Keep edits focused to the smallest relevant area.
- Do not rename route/protocol fields or change saved route compatibility.

## Verification

Use focused Studio checks after changes:

```text
corepack pnpm --filter @snarkroute/studio build
corepack pnpm --filter @snarkroute/studio test
```

`test` currently uses `--passWithNoTests`, so `build` is the main immediate
verification until focused Studio tests are added.

## Model Catalog

- UI must not hardcode model output types, icons, or generation parameters.
- UI should consume `/api/models`.
- Do not add model name regexes in UI.
- Do not modify model catalog logic unless the task explicitly asks for model, provider, or catalog changes.
