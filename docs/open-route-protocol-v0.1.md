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
  license: MIT
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
```

Cycles are executor-level errors, not protocol parse errors.

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
- `transform.template`: outputs `{ text }`
- `debug.log`: logs and outputs `{ value }`
- `output.file`: writes text or JSON to a local run folder
- `replicate.model`: runs a Replicate model prediction on the local server
