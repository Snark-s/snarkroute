# Open Route Protocol v0.1

Open Route Protocol is a portable route format for describing AI/model/API workflows as graphs. Routes can reference external assets, but only through the AssetRef system. The host application controls how asset references are resolved, validated, cached, embedded, bundled, or blocked.

Open Route Protocol uses explicit file extensions:

- `.orp` is the canonical user-facing extension for complete Open Route Protocol route documents.
- `.orp.json` and `.orp.yaml` are explicit developer-friendly variants.
- `.route` remains supported as a human-readable compatibility alias.
- `.route.json`, `.route.yaml`, and `.route.yml` remain supported compatibility aliases.
- `.node.json` describes reusable node type definitions.

Route files contain node instances, edges, params, provenance, economics metadata, and AssetRefs. They do not directly load files, URLs, JSON, Markdown, node definitions, or executable resources.

Node definition files describe reusable node types. Do not use `.node.json` for node instances inside a route. Future Node Definition Assets may be referenced through AssetRef, but remote node definitions must describe interfaces and execution adapters, not arbitrary executable code.

For v0.1, `.orp` and `.route` serialize as JSON. `.orp.yaml`, `.orp.yml`, `.route.yaml`, and `.route.yml` serialize as YAML.

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

## Asset System

SnarkRoute uses two levels:

- Route level: routes contain nodes, edges, params, and AssetRefs.
- Asset resolution level: the host application has configured AssetSources. AssetResolver takes an AssetRef and resolves it to a normalized asset.

Routes store references to reusable assets, not raw external files. The resolver validates schema, kind, version, hash, permissions, and trust rules where applicable.

AssetRef example:

```json
{
  "uri": "asset://local/text/prompt/image-generation/retro-futuristic-editor-joke",
  "kind": "text/prompt",
  "expectedHash": "sha256:...",
  "version": "1.0.0"
}
```

Normalized Text Asset example:

```json
{
  "schema": "open-route-asset.v0",
  "kind": "text/prompt",
  "id": "retro-futuristic-editor-joke",
  "title": "Retro-futuristic editor joke",
  "version": "1.0.0",
  "content": {
    "text": "A retro-futuristic easter egg illustration..."
  }
}
```

## MVP Node Types

- `input.text`: outputs `{ text }`
- `input.file`: reads a local file path and outputs `{ path, filename, mimeType, sizeBytes }`
- `input.image`: reads a local image path and outputs `{ path, filename, mimeType, sizeBytes, width, height }`
- `input.video`: reads a local video path and outputs `{ path, filename, mimeType, sizeBytes, width?, height?, durationSec? }`
- `library.prompt`: resolves `params.assetRef` to a `text/prompt` or compatible text asset and outputs `{ text }`
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

## Local Input Nodes

Local asset input nodes use `params.path`:

```yaml
nodes:
  - id: image_asset
    type: input.image
    params:
      path: C:\path\to\image.png
```

`input.file` accepts any known local file type. `input.image` currently supports metadata for PNG, JPG, and WebP. `input.video` validates video file types and returns basic file metadata; `width`, `height`, and `durationSec` are optional in the MVP.

Absolute local paths are useful for local-first execution, but they reduce route portability across machines. They are an MVP input-node convenience, not the pattern for reusable route resources. Reusable resources should be referenced through AssetRef.

## Prompt Library Route Example

```json
{
  "schema": "open-route.v0",
  "nodes": [
    {
      "id": "prompt1",
      "type": "library.prompt",
      "params": {
        "assetRef": {
          "uri": "asset://local/text/prompt/image-generation/retro-futuristic-editor-joke",
          "kind": "text/prompt"
        }
      }
    },
    {
      "id": "image1",
      "type": "image.generate",
      "params": {
        "prompt": "{{prompt1.output.text}}"
      }
    }
  ],
  "edges": [
    {
      "from": "prompt1",
      "to": "image1"
    }
  ]
}
```

`library.prompt` must not contain `mode: linked`, `mode: embedded`, direct file paths, direct URLs, or `embeddedText` as a node mode. Linked, embedded, and bundle are export modes.

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
