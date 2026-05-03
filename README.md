# SnarkRoute

SnarkRoute is a local-first visual editor and executor for Open Route Protocol.

Open Route Protocol is the portable standard for describing AI/model/API routes. SnarkRoute is the reference implementation: a small working MVP that proves route documents can be created, inspected, remixed, validated, and executed locally.

## What Is Open Route Protocol?

Open Route Protocol describes portable `.route.yaml` and `.route.json` documents. A route can contain inputs, transforms, model/API providers, outputs, provenance, and economics metadata without being locked to one platform.

SnarkRoute is not just a Replicate wrapper. Replicate is the first external provider inside routes; the route/workflow is the primary unit of value.

## Why Routes Are The Unit Of Value

A single model call is useful, but a shareable workflow is more valuable: it captures intent, inputs, provider choices, transformations, outputs, provenance, and future attribution/economics metadata. Open Route Protocol keeps that workflow portable.

## Current MVP Features

- Open Route Protocol v0.1 schema, parsing, validation, YAML and JSON support
- DAG executor with topological sorting, cycle detection, template references, logs, and run results
- Local filesystem run storage under `data/runs/`
- Local ledger accounting under `data/ledger/runs.jsonl`
- Built-in nodes for text, files, images, videos, templates, debug logs, text output, image preview, and file output
- Replicate provider adapter and model-specific Clarity Upscaler node
- Vite + React + React Flow Studio
- Import/export `.route.json`
- Local settings for Replicate token through `.env` or Studio Settings

## Screenshots And Demo

Use `docs/demo-script.md` for a short recording plan. It covers:

- `input.text -> replicate.model -> output.file`
- `input.image -> replicate.clarity-upscaler -> preview.image -> output.file`

Project screenshots or generated demo media can be added later; do not commit private runs, tokens, or user outputs.

## Quick Start

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm build
corepack pnpm dev
```

`corepack pnpm dev` runs the local Fastify server and Studio in parallel.

You can also run them separately:

```bash
corepack pnpm dev:server
corepack pnpm dev:studio
```

The API listens on `http://127.0.0.1:4317` by default. Studio runs on `http://127.0.0.1:5173` and connects to `VITE_API_BASE_URL`, defaulting to `http://127.0.0.1:4317`.

## Dev Ports

SnarkRoute uses explicit local dev ports so two clones do not accidentally talk to the same backend.

Server:

```bash
API_PORT=4317 corepack pnpm dev:server
```

Studio:

```bash
VITE_API_BASE_URL=http://127.0.0.1:4317 corepack pnpm dev:studio
```

For a second clone, use a different API port and point that clone's Studio at it:

```bash
# Clone A
API_PORT=4317 corepack pnpm dev:server
VITE_API_BASE_URL=http://127.0.0.1:4317 corepack pnpm dev:studio

# Clone B
API_PORT=4318 corepack pnpm dev:server
VITE_API_BASE_URL=http://127.0.0.1:4318 corepack pnpm dev:studio
```

On Windows PowerShell:

```powershell
$env:API_PORT="4318"; corepack pnpm dev:server
$env:VITE_API_BASE_URL="http://127.0.0.1:4318"; corepack pnpm dev:studio
```

Studio shows the active API URL, connection status, and Replicate token status in the top bar. If the API is not reachable, it shows: `Local API server is not reachable at <url>. Start the server or check VITE_API_BASE_URL.`

## Configuring API Tokens

Replicate nodes require a local Replicate API token.

In Studio:

1. Open `Settings`.
2. Open `Secrets`.
3. Open `Replicate`.
4. Paste the token and click `Save Token`.

Studio shows only whether the token is `configured` or `missing`. It never reads the token value back from the server.

Fallback: copy `.env.example` to `.env` and add your token:

```env
REPLICATE_API_TOKEN=your_token_here
```

Tokens are stored locally and used only by the server. They are not exported with routes or bundles. Do not commit `.env`.

## Smoke Tests

Live smoke tests are not part of the normal test suite because they call external providers.

```bash
corepack pnpm smoke:replicate
corepack pnpm smoke:clarity
```

They require `REPLICATE_API_TOKEN`. They must not print or store the token.

## Example Routes

Routes live in `examples/routes`:

- `debug-basic.route.yaml`
- `flux-basic.route.yaml`
- `replicate-flux-basic.route.yaml`
- `template-chain.route.yaml`
- `file-debug.route.yaml`
- `image-debug.route.yaml`
- `video-debug.route.yaml`
- `clarity-upscale-basic.route.yaml`

Example route documents are licensed under CC BY-SA 4.0 unless otherwise stated.

## Local Asset Inputs

Studio supports local input nodes:

- `input.file`
- `input.image`
- `input.video`

Add one from the node library, then use `Browse...` or drag a local image onto the canvas. The selected absolute path is stored in `params.path` and exported as part of the route document.

Absolute local paths are an MVP limitation: they work well on the current machine, but reduce portability when sharing routes.

## Clarity Upscaler Example

SnarkRoute includes a model-specific node for Replicate Clarity Upscaler:

```text
input.image -> replicate.clarity-upscaler -> preview.image -> output.file
```

In Studio:

1. Add `Input Image`, choose or drop a local image.
2. Add `Clarity Upscaler`.
3. Connect the image port from `Input Image` to `Clarity Upscaler`.
4. Adjust `prompt`, `negative_prompt`, `scale_factor`, `dynamic`, `creativity`, `resemblance`, `num_inference_steps`, and `seed` directly in the node.
5. Use `Image Preview` to view the result, or `Save Text File`/`Output File` when you explicitly want a local route output artifact.

Downloaded model outputs are stored under:

```text
data/runs/<runId>/assets/
```

Replicate output URLs may expire, so SnarkRoute downloads the first returned image locally when the Clarity run succeeds.

## Economics Metadata And Run Accounting

SnarkRoute v0.1 stores economics as metadata and local accounting only. It does not execute payments, settlements, marketplace actions, checkout, billing API calls, blockchain calls, or share payouts.

Routes can include authors, contributors, revenue splits, provider cost hints, currency, and notes. Every run gets a local accounting summary with `paymentExecuted: false`, provider usage events such as Replicate prediction ids, and estimated/actual provider costs when known. Actual provider cost may be `null`.

The ledger is local, ignored by git, and not exported with route documents:

```text
data/ledger/runs.jsonl
```

Secrets such as API tokens are not stored in economics metadata or ledger entries.

## Security Notes

- Do not commit `.env`, local runs, local assets, generated outputs, or private user files.
- Routes and bundles must not contain secret values.
- SnarkRoute does not execute arbitrary community JavaScript.
- Future community nodes must be declarative manifests with explicit permissions.
- External provider outputs are the user's responsibility and are subject to provider/model/service terms.

See `SECURITY.md` for more detail.

## Current Limitations

- No authentication
- No cloud deployment
- No user accounts
- No marketplace
- No payments
- No arbitrary community JavaScript execution
- No complex database
- Absolute local asset paths reduce route portability
- Provider actual costs may be unknown

## Roadmap

See `docs/roadmap.md`.

Short version:

- v0.1-alpha: protocol, executor, Studio, Replicate, local assets
- v0.2: secrets/profiles
- v0.3: route bundles
- v0.4: community node manifests
- v0.5: async task nodes
- v0.6: route macros
- v1.0: stable Open Route Protocol

## Contributing

See `CONTRIBUTING.md`.

Code contributions are accepted under AGPL-3.0-or-later. Documentation, specification, and example route contributions are accepted under CC BY-SA 4.0 unless otherwise stated.

## License

SnarkRoute source code is licensed under AGPL-3.0-or-later.

Open Route Protocol specification, documentation, and example route documents are licensed under CC BY-SA 4.0 unless otherwise stated.

Generated outputs created by users through SnarkRoute are not automatically covered by AGPL or CC BY-SA and belong to their creators/users, subject to the terms of the models, APIs, routes, and services used.

Third-party dependencies are governed by their own licenses.

See `LICENSES.md` for the full project license map.
