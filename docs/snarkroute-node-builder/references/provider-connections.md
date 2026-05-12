# SnarkRoute Provider Connections

This reference is bundled so the skill can reason about API connections before creating API-backed nodes.

## Current Known Connections

SnarkRoute's right Settings column commonly exposes:

- OpenRouter
  - Env key: `OPENROUTER_API_KEY`
  - Host: `openrouter.ai`
  - Role: primary remote provider for many AI models
  - Server pattern: `GET /api/settings`, `POST /api/settings/openrouter`, OpenRouter test/catalog endpoints
- Gemini
  - Env key: `GEMINI_API_KEY`
  - Host: `generativelanguage.googleapis.com`
  - Role: direct advanced provider for Gemini text and image nodes
  - Server pattern: `GET /api/settings`, `POST /api/settings/gemini-token`
- OpenAI
  - Env key: `OPENAI_API_KEY`
  - Host: `api.openai.com`
  - Role: direct advanced provider for OpenAI-specific API nodes
  - Server pattern: `GET /api/settings`, `POST /api/settings/openai-token`
- Replicate
  - Env key: `REPLICATE_API_TOKEN`
  - Host: `api.replicate.com`
  - Role: direct advanced provider for Replicate model nodes
  - Server pattern: `GET /api/settings`, `POST /api/settings/replicate-token`

If a node must call `api.openai.com` directly, it needs the direct OpenAI connection unless the specific model can be executed through an existing OpenRouter route.

## Connection Discovery Workflow

For API-backed nodes:

1. Identify the exact provider endpoint and auth scheme from official docs or from the user's explicit spec.
2. Check whether the provider can use an existing SnarkRoute connection.
3. If editing a SnarkRoute checkout, inspect:
   - `apps/studio/src/main.tsx`
   - `apps/server/src/index.ts`
   - `data/provider-links.json` if present
4. If the provider exists, reuse its env key and host in the node manifest.
5. If the provider is absent and the user expects a working app integration, add a connection using the same pattern as existing providers.
6. If only a portable node package is requested, do not edit the app. Put the required env key in `permissions.env`, the host in `permissions.networkHosts`, and document the setup in README.

## Adding A Missing Direct Provider

Follow existing local patterns rather than inventing a new settings system.

Server side:

- Include provider status in `GET /api/settings`.
- Add a `POST /api/settings/<provider>` or `POST /api/settings/<provider>-token` endpoint.
- Validate that the submitted key is non-empty.
- Persist through the existing environment writer.
- Update `process.env.<KEY>` immediately.
- Add an `is<Provider>Enabled()` helper if existing providers use helpers.
- Keep secrets out of responses; return only configured/masked status.

Studio side:

- Add configured state with `useState(false)` or match the local settings shape.
- Load configured status from `/api/settings`.
- Add a save function mirroring existing providers.
- Add a right-column Settings card or Advanced/Direct entry.
- Add provider help links if the app has a provider-links registry.
- Add node-level "Configure <Provider>" hints for nodes that require that key.

Node package:

- `permissions.network: true`
- `permissions.networkHosts: ["api.provider.example"]`
- `permissions.env: ["PROVIDER_API_KEY"]`
- Never put keys in params, examples, route files, README examples, logs, or generated code comments.

## OpenAI Direct Baseline

Use this only when direct OpenAI access is required:

- Provider label: `OpenAI`
- Env key: `OPENAI_API_KEY`
- Host: `api.openai.com`
- Suggested server endpoint: `/api/settings/openai-token`
- Suggested settings text: "OpenAI API key saved locally. Do not commit API keys to git."
- Manifest permissions:

```json
{
  "network": true,
  "networkHosts": ["api.openai.com"],
  "readFiles": true,
  "writeOutputs": true,
  "shell": false,
  "env": ["OPENAI_API_KEY"]
}
```

If the task specifically names ChatGPT Image / GPT Image through OpenAI, prefer direct OpenAI only when OpenRouter support is absent or not verified.
