# SnarkRoute for Adobe After Effects (CEP MVP)

Dockable After Effects panel for provider-neutral image and video generation:

`prompt/current frame/external image -> local SnarkRoute server -> Model Gateway -> image or video -> Project import / placeholder replacement`.

The extension contains no provider adapters or API keys. It uses the configuration of the existing local SnarkRoute server.

## Requirements

- Windows, Adobe After Effects with CEP 11 support (AE 2021/18.0 or newer)
- Node.js 20+ and pnpm 9.1.0 (the repository pins the package-manager version)
- a saved or unsaved AE project; an active composition is optional for text-to-image and external-file image-to-image
- credentials for at least one executable catalog provider (Polza, OpenRouter, or Gemini)

## Build and install

From the repository root:

```powershell
corepack pnpm install
corepack pnpm build:after-effects
corepack pnpm install:after-effects
```

The install command creates a development junction at:

```text
%APPDATA%\Adobe\CEP\extensions\com.snarkroute.aftereffects
```

It refuses to replace a real directory. Remove only the development junction with:

```powershell
corepack pnpm --filter @snarkroute/after-effects-panel uninstall:dev
```

For rebuild-on-change use `corepack pnpm --filter @snarkroute/after-effects-panel watch`. The Vite dev server command is available as `corepack pnpm dev:after-effects`, but installed CEP loads the built `dist/index.html` so watch mode is the normal workflow.

## Enable unsigned CEP extensions

For CEP 11, create the string value `PlayerDebugMode=1` under `HKEY_CURRENT_USER\Software\Adobe\CSXS.11`. Other AE releases can use a neighboring `CSXS.<version>` key. This repository does not modify the registry automatically. Restart After Effects after changing it.

## Run SnarkRoute

```powershell
corepack pnpm dev:server
```

The default local endpoint is `http://127.0.0.1:4317`. The panel stores a custom URL locally and offers **Reconnect**. Studio, BoojumRoute, and Canvas are not required.

## First generation

1. Optionally open a composition and move the current-time indicator to the source frame.
2. Open **Window -> Extensions (Legacy) -> SnarkRoute**.
3. Confirm the server is connected.
4. Choose an operation and a compatible model from the live executable SnarkRoute catalog.
5. Enter a prompt, review schema-derived parameters and optionally refresh the quote.
6. Press **Generate**.

For current-frame operations the host script exports a temporary PNG with `CompItem.saveFrameToPng`. A placeholder is created only after the provider job exists. Image placeholders are still layers whose out-point runs to the end of the active composition; this is the most natural AE editing behavior and avoids applying a generated-video duration to a still. The result replaces the layer source through `layer.replaceSource(importedItem, false)`, preserving transforms, masks, effects, parenting, markers, blend mode, and timing. Text-to-image without a composition imports directly into the Project panel.

## Output and metadata

Saved projects use `<project directory>\SnarkRoute Generations\Images|Videos`. Unsaved projects use `%APPDATA%\SnarkRoute Generations\Images|Videos`, with `%TEMP%` as the fallback. The AE project mirrors this with **SnarkRoute Generations/Images** and **SnarkRoute Generations/Videos** without moving existing user items.

Every output has a sibling `<video>.json` manifest. The generated layer receives a comment and marker with the job id, model id, and manifest path. The panel persists the active job in CEP local storage and resumes polling after a panel reload.

## Server API reused and added

Reused:

- `GET /api/models/executable-generation` — executable image/video entries derived from Model Catalog V1 and registered builtin runners
- `POST /api/model-gateway/quote` — existing pricing path
- `POST /api/assets/import` — existing local asset materialization
- `createRouteExecutor()` and `polza.video.generate` — existing Model Gateway/provider adapter path

Added as a thin local orchestration layer:

- `POST /api/model-gateway/jobs`
- `GET /api/model-gateway/jobs/:id`
- `GET /api/model-gateway/jobs/:id/result`

Job metadata is persisted under `apps/server/data/model-gateway-jobs` when the server runs from that workspace. No secrets are serialized. Cloud mode does not expose local job creation.

## Known MVP limitations

- Active sources are current composition frame and external image file. Selected-layer frame, footage-item, composition-region, matte-layer and AE-mask sources remain inactive follow-up architecture.
- Inpainting/outpainting/edit/upscale are shown only when the live catalog exposes the corresponding capability, input contract and executable runner. The current general image catalog primarily exposes text-to-image and image-to-image; no model-name heuristics are used.
- PNG, JPEG, WebP and TIFF imports are attempted through AE. Original unsupported provider files are preserved, but no new conversion dependency was added; automatic PNG conversion requires an existing conversion layer.
- Batch outputs are downloaded and imported together. The first replaces the placeholder; the rest remain in the Project panel and can be added together without duplicating existing source layers.
- Provider cancellation is not exposed by the current gateway, so no Cancel button is shown.
- A server restart cannot resume a provider operation whose polling state lives inside the adapter; persisted queued/running jobs are marked failed with a restart explanation. The output remains on disk if it was already written.
- Placeholder references use composition id, layer index, and footage item id. Reordering/removing the placeholder during generation can prevent automatic metadata attachment; the downloaded result and manifest are still retained.
- CEP itself and ExtendScript integration require manual verification in a real After Effects installation; automated tests cover the client, filtering, parameter mapping, job state, manifest, and server job orchestration.
- Generation details are restored from the panel's persisted active job. Detecting metadata by selecting any older generated layer is not part of this vertical slice yet.
