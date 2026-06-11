# Model Catalog Agent Instructions

- This package is the single source of truth for curated model metadata.
- Do not infer known model output types, icons, or parameters from model names.
- Unknown provider models must remain `outputType: "unknown"` and `catalogStatus: "unknown"`.
- Do not change existing model ids unless explicitly requested.
- Every new known model must define `provider`, `providerModelId`, `displayName`, `outputType`, `inputTypes`, `iconKey`, `parameters`, and `catalogStatus` through normal package helpers.

## Verification

```text
corepack pnpm --filter @snarkroute/model-catalog test
corepack pnpm --filter @snarkroute/model-catalog build
```
