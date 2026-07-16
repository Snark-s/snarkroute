# SnarkRoute for Adobe After Effects (CEP MVP)

Dockable After Effects panel for the first working SnarkRoute video-generation path:

`active composition frame -> PNG -> local SnarkRoute server -> Model Gateway / Polza -> video -> placeholder replacement`.

The extension contains no provider adapters or API keys. It uses the configuration of the existing local SnarkRoute server.

## Requirements

- Windows, Adobe After Effects with CEP 11 support (AE 2021/18.0 or newer)
- Node.js 20+ and pnpm 9.1.0 (the repository pins the package-manager version)
- a saved or unsaved AE project with an active composition
- `POLZA_AI_API_KEY` configured in the repository `.env`

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

1. Open a composition and move the current-time indicator to the source frame.
2. Open **Window -> Extensions (Legacy) -> SnarkRoute**.
3. Confirm the server is connected.
4. Choose an image-to-video model from the live SnarkRoute catalog.
5. Enter a prompt, review schema-derived parameters and optionally refresh the quote.
6. Press **Generate**.

The host script exports a temporary PNG with `CompItem.saveFrameToPng`, creates placeholder footage/layer at the current time, and leaves the user's composition content unchanged. The panel uploads through the existing `/api/assets/import`, creates an async `/api/model-gateway/jobs` job, polls it, writes the result, and calls `FootageItem.replace()`. Replacing the footage item preserves the layer, transforms, masks, effects, blend mode, and timing.

## Output and metadata

Saved projects use `<project directory>\SnarkRoute Generations`. Unsaved projects use `%APPDATA%\SnarkRoute Generations`. The imported footage is grouped under **SnarkRoute Generations** in the AE project.

Every output has a sibling `<video>.json` manifest. The generated layer receives a comment and marker with the job id, model id, and manifest path. The panel persists the active job in CEP local storage and resumes polling after a panel reload.

## Server API reused and added

Reused:

- `GET /api/models/for-node/polza.video.generate` — executable entries from Model Catalog V1
- `POST /api/model-gateway/quote` — existing pricing path
- `POST /api/assets/import` — existing local asset materialization
- `createRouteExecutor()` and `polza.video.generate` — existing Model Gateway/provider adapter path

Added as a thin local orchestration layer:

- `POST /api/model-gateway/jobs`
- `GET /api/model-gateway/jobs/:id`
- `GET /api/model-gateway/jobs/:id/result`

Job metadata is persisted under `apps/server/data/model-gateway-jobs` when the server runs from that workspace. No secrets are serialized. Cloud mode does not expose local job creation.

## Known MVP limitations

- The complete source path is **Current composition frame -> image-to-video**. External files, selected footage, work-area rendering, video-to-video, history, and regenerate UI remain follow-up work.
- The executable catalog endpoint currently exposes the Polza video node. OpenRouter video support used elsewhere in the library service does not yet have the same provider-neutral node runner, so the panel does not advertise it.
- Provider cancellation is not exposed by the current gateway, so no Cancel button is shown.
- A server restart cannot resume a provider operation whose polling state lives inside the adapter; persisted queued/running jobs are marked failed with a restart explanation. The output remains on disk if it was already written.
- Placeholder references use composition id, layer index, and footage item id. Reordering/removing the placeholder during generation can prevent automatic metadata attachment; the downloaded result and manifest are still retained.
- CEP itself and ExtendScript integration require manual verification in a real After Effects installation; automated tests cover the client, filtering, parameter mapping, job state, manifest, and server job orchestration.
- Generation details are restored from the panel's persisted active job. Detecting metadata by selecting any older generated layer is not part of this vertical slice yet.
