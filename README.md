# SnarkRoute

SnarkRoute is a local-first reference editor and executor for Open Route Protocol.

Open Route Protocol is the portable standard. SnarkRoute is the app proving the standard with a working MVP.

The route is the unit of value: a shareable workflow that can describe inputs, transforms, model/API providers, outputs, provenance, and future economics metadata. Replicate is included as the first external model provider, but SnarkRoute is not a Replicate wrapper.

## Install

```bash
pnpm install
```

If `pnpm` is not installed as a shell command, use Corepack:

```bash
corepack pnpm install
```

## Test

```bash
pnpm test
```

## Build

```bash
pnpm build
```

## Run The Local Server

```bash
pnpm dev:server
```

The API listens on `http://127.0.0.1:4317`.

## Run Studio

```bash
pnpm dev:studio
```

Studio runs on `http://127.0.0.1:5173` and proxies `/api` to the local server.

## Add Replicate

Create `.env` from `.env.example`:

```bash
REPLICATE_API_TOKEN=your_token_here
```

The token is read only by `apps/server`; it is never exposed to Studio.

## Example Routes

Routes live in `examples/routes`:

- `debug-basic.route.yaml`
- `flux-basic.route.yaml`
- `file-debug.route.yaml`
- `image-debug.route.yaml`
- `video-debug.route.yaml`
- `replicate-flux-basic.route.yaml`
- `template-chain.route.yaml`

## Local Asset Inputs

Studio supports local input nodes:

- `input.file`
- `input.image`
- `input.video`

Add one from the node library, then use `Browse...` in the node to select a local file. The selected absolute path is stored in `params.path` and exported as part of the `.route.json` file.

Outputs:

- `input.file`: `path`, `filename`, `mimeType`, `sizeBytes`
- `input.image`: `path`, `filename`, `mimeType`, `sizeBytes`, `width`, `height`
- `input.video`: `path`, `filename`, `mimeType`, `sizeBytes`, optional `width`, `height`, `durationSec`

Absolute local paths are an MVP limitation: they work well on the current machine, but reduce portability when sharing routes with other users.

The Studio MVP imports `.route.json`. YAML is supported by the protocol package and examples document the portable format.

## MVP Limitations

- No auth
- No cloud deployment
- No accounts
- No marketplace
- No payments
- No arbitrary community JavaScript execution
- No database

## Roadmap

- Better route inspector and YAML import/export
- Declarative node manifests with explicit permissions
- More provider adapters
- Stronger provenance event history
- Compatibility tests for protocol evolution
- Optional economics execution outside the MVP
