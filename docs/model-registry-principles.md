# Model Registry Principles

SnarkRoute keeps model choice portable by treating providers as adapters, not architecture roots. OpenRouter, OpenAI, Anthropic, Google, Ollama, Replicate, Comfy, custom HTTP, and local services are peers behind adapter boundaries.

## Concepts

- **Provider**: an executable adapter or host.
- **Model**: a provider model id.
- **Model Profile**: shareable route-facing model intent with `modelProfileId`, provider/model ids, capabilities, cost/privacy classes, limits, and fallbacks.
- **Agent Preset**: role, system prompt, style, or behavior. It is not a model.
- **Dialogue Workbench Node**: a route block that can choose a model profile per assistant message and preserve execution facts on messages.

## Rules

1. Providers are adapters, not architecture roots.
2. Nodes depend on capabilities and `modelProfileId`, not provider APIs.
3. Routes store model intent. Outputs, messages, and run records store execution facts.
4. Profiles are shareable. Credentials are local settings only.
5. Cost, privacy, capabilities, and limits should be visible before execution.
6. No hidden spend: expensive or dangerous profiles require explicit user action or limits for bulk/automatic runs.
7. Agent Presets remain separate from Model Profiles.
8. BoojumRoute gets a technical registry first; SnarkRoute can later show the same profiles as intelligence resources on the living canvas.

## Current Implementation

Portable types and validation live in `packages/protocol/src/model-registry.ts`, with a core-facing re-export from `packages/core`. The first default profiles map current BoojumRoute behavior without moving secrets into routes:

- `text.default`: remote text profile alias, currently resolved by existing remote text adapter settings.
- `image.nano-banana`: existing Gemini image route profile.
- `local.stable-diffusion`: local WebUI-compatible profile.

Legacy nodes with `params.model` and provider-specific settings continue to load. New route-facing work should prefer `modelProfileId`, `requiredCapabilities`, and `fallbackProfileIds` where applicable. API keys remain in local `.env`/settings and are stripped from route export.
