# Nodes And Node Definition Assets

Routes contain node instances. Node definitions describe reusable operation interfaces.

A node is not the implementation. An implementation or provider is how that operation is executed: a local runner, hosted API, model provider, GPU server, media tool, or custom integration.

## Asset-Aware Nodes

Nodes that need reusable external resources should store AssetRefs, not direct file paths or URLs. For example, `library.prompt` stores `params.assetRef` and asks AssetResolver for a compatible Text Asset.

A node does not decide whether an asset is linked or embedded. Linked, embedded, and bundle are export modes.

## Remote Node Definitions

Remote node definitions are not arbitrary executable code.

A remote Node Definition Asset may describe:

- node id
- title
- version
- inputs
- outputs
- UI metadata
- execution adapter
- endpoint or provider type
- required permissions
- required credentials

Example:

```json
{
  "schema": "open-route-asset.v0",
  "kind": "node/definition",
  "id": "replicate-flux",
  "title": "Replicate FLUX",
  "version": "1.0.0",
  "inputs": {
    "prompt": "text"
  },
  "outputs": {
    "image": "image"
  },
  "execution": {
    "type": "http-api",
    "adapter": "replicate"
  },
  "permissions": [
    "network",
    "api-key:replicate"
  ]
}
```

Remote Node Definition Assets must not silently inject arbitrary executable JS/TS/Python code into SnarkRoute. The host must show permissions before enabling external node definitions, and credentials remain host-side.

---

This document is licensed under CC BY-SA 4.0.
