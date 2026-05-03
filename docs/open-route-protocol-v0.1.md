# Open Route Protocol v0.1

Open Route Protocol describes portable route documents for AI/model/API workflows.

Supported file extensions:

- `.route.yaml`
- `.route.json`

## Route Document

```yaml
routeVersion: "0.1"
route:
  id: my-route
  title: My Route
  description: Optional description
  author:
    name: Creator
    did: null
    wallet: null
  license: CC-BY-SA-4.0
  tags: [example]
economics:
  enabled: false
  authorShare: 0.1
  modelShares:
    - model: owner/model
      share: 0.2
  notes: Preserved even when not executed.
nodes:
  - id: input_prompt
    type: input.text
    params:
      value: Hello
edges:
  - from: input_prompt
    to: output
provenance:
  createdAt: "2026-04-30T00:00:00.000Z"
  tool: snarkroute
  events: []
```

## Nodes

Every node has:

- `id`: unique string
- `type`: node type, such as `input.text` or `replicate.model`
- `title`: optional display title
- `params`: declarative node parameters
- `inputs`, `outputs`, `ui`: optional metadata

Unknown node types are valid at the protocol level. Executors may fail if no runner is registered.

## Edges

Edges connect node ids:

```yaml
edges:
  - id: optional-edge-id
    from: input_prompt
    to: template
    fromPort: text
    toPort: template
```

Cycles are executor-level errors, not protocol parse errors.

`fromPort` and `toPort` are optional. They let an editor distinguish multiple outputs from the same node while preserving the simple `from` -> `to` dependency relationship. Older routes without port fields remain valid.

## References And Templates

Node port references use:

- `nodeId.output.text`
- `nodeId.input.prompt`

Params may contain template references:

```yaml
template: "Prompt: {{input_prompt.output.text}}"
```

In the MVP, edges define graph dependencies and execution order. Template references define value binding. If a node references another node in params, there must be an edge from the referenced node to the referencing node. The executor rejects missing referenced nodes, missing dependency edges, and missing output fields with clear errors.

## MVP Node Types

- `input.text`: outputs `{ text }`
- `input.file`: reads a local file path and outputs `{ path, filename, mimeType, sizeBytes }`
- `input.image`: reads a local image path and outputs `{ path, filename, mimeType, sizeBytes, width, height }`
- `input.video`: reads a local video path and outputs `{ path, filename, mimeType, sizeBytes, width?, height?, durationSec? }`
- `preview.image`: passes through image values and lets Studio render a local or remote preview
- `transform.template`: outputs `{ text }`
- `debug.log`: logs and outputs `{ value }`
- `output.text`: displays text or JSON output without writing a file
- `output.file`: writes text or JSON to a local run folder
- `replicate.model`: runs a Replicate model prediction on the local server
- `replicate.clarity-upscaler`: application-specific node over Replicate `philz1337x/clarity-upscaler`; accepts image input and returns downloaded image metadata

## Economics

`economics` is optional in v0.1. When present, it is metadata and local accounting configuration only:

```yaml
economics:
  enabled: true
  mode: metadata-only
  currency: USD
  author:
    id: author-1
    name: Route Author
    role: route-author
    share: 0.5
    wallet: null
    did: did:example:author
  contributors:
    - id: artist-1
      name: Artist
      role: artist
      share: 0.25
  revenueSplits:
    - recipientId: author-1
      share: 0.5
      reason: route authorship
  providerCosts:
    - provider: replicate
      model: philz1337x/clarity-upscaler
      nodeType: replicate.clarity-upscaler
      pricingHint: external-provider-billing
      estimatedCost: null
      actualCost: null
  notes: Metadata only. No payment execution in v0.1.
```

Rules:

- `mode` is `metadata-only`, `accounting-only`, or `disabled`.
- `share` values must be between `0` and `1`.
- `revenueSplits` share total must be `<= 1`.
- `wallet` and `did` are portable metadata only.
- `paymentExecuted` is never part of route metadata and is always `false` in v0.1 run accounting.
- Older MVP fields such as `authorShare` and `modelShares` remain valid for compatibility.

## Local Asset Inputs

Local asset input nodes use `params.path`:

```yaml
nodes:
  - id: image_asset
    type: input.image
    params:
      path: C:\path\to\image.png
```

`input.file` accepts any known local file type. `input.image` currently supports metadata for PNG, JPG, and WebP. `input.video` validates video file types and returns basic file metadata; `width`, `height`, and `durationSec` are optional in the MVP.

Absolute local paths are useful for local-first execution, but they reduce route portability across machines. Future protocol versions may add portable asset IDs or manifests; v0.1 preserves paths exactly as route metadata.

## Clarity Upscaler Node

`replicate.clarity-upscaler` is a SnarkRoute application node built on top of the generic Replicate adapter. It is not a marketplace/plugin system. It exists to make one real image-to-image route work well in the MVP.

Recommended binding:

```yaml
nodes:
  - id: input_image
    type: input.image
    params:
      path: C:\path\to\image.png
  - id: upscale
    type: replicate.clarity-upscaler
    params:
      scale_factor: 2
      creativity: 0.25
      resemblance: 0.8
edges:
  - from: input_image
    to: upscale
    fromPort: image
    toPort: image
  - from: upscale
    to: output_text
    fromPort: output
    toPort: from
```

The executor passes the `input.image` output object through the edge. The clarity node also supports `params.image: "{{input_image.output.path}}"`, but the Studio route can rely on the edge input.

Clarity output includes an estimated `cost` object when Replicate returns prediction timing metrics. This is an estimate for the completed prediction, calculated from actual prediction seconds and SnarkRoute's default per-second estimate; final provider billing may differ.

---

Open Route Protocol specification is licensed under CC BY-SA 4.0.
