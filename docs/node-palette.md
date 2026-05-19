# Node Palette

Studio groups BoojumRoute blocks by the route-building flow rather than by implementation package. The palette should help users assemble a route from left to right: sources, prompting, generation, tooling, integration, outputs, and debugging.

The UI and compatibility formats may still say "node", but this palette is for executable BlockNodes. It is not the SnarkRoute Artifact model.

## Section Order

1. Inputs & Assets
2. Text & Prompting
3. Image Generation
4. Image Tools & Preview
5. API & Integration
6. Outputs
7. Debug
8. Capabilities
9. Installed or package-defined sections

## Built-In Node Order

### Inputs & Assets

- `input.text`
- `library.prompt`
- `input.image`
- `input.video`
- `input.file`

### Text & Prompting

- `transform.template`
- `gemini.llm`

### Image Generation

- `gemini.nano-banana-2`
- `local.stableDiffusion.textToImage`

### Image Tools & Preview

- `replicate.clarity-upscaler`
- `preview.image`

### API & Integration

- `http.request`

### Outputs

- `output.text`
- `output.file`

### Debug

- `debug.log`

### Capabilities

- `capability.image.create`
- `capability.image.edit`
- `capability.image.upscale`
- `capability.video.animate`
- `capability.character.create`
- `capability.location.create`

Capabilities are lower-level declarative intent nodes. Keep them after concrete runnable nodes until the provider-selection layer becomes a primary user workflow.

## Rules

- Put source nodes before transforms and providers.
- Put prompt-producing nodes near other inputs, because prompts are route assets.
- Put provider-specific image generators before image post-processing and preview nodes.
- Put generic HTTP/API nodes after media and text workflow nodes.
- Put outputs near the end, followed by debugging tools.
- Keep known built-in nodes in the explicit order above.
- Keep unknown installed nodes in their manifest category, sorted by title.
- Add a new section only when an existing section would make the route-building flow less clear.
- Do not group by package name, executor runtime, or provider alone when that hides the user workflow.

---

This document is licensed under CC BY-SA 4.0.
