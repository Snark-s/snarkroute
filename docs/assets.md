# Asset System

SnarkRoute routes store references to reusable assets, not raw external files. AssetRef resolution is handled by the host application through explicitly configured AssetSources and an AssetResolver.

## Two Levels

Level 1: Route level

Routes contain nodes, edges, params, and AssetRefs. In Open Route Protocol v0.1, route nodes are executable BlockNodes unless a later documented protocol extension says otherwise. Routes do not directly load files, URLs, JSON, Markdown, node definitions, or executable resources.

Level 2: Asset resolution level

The host application has configured AssetSources. AssetResolver takes an AssetRef and resolves it to a normalized asset. The resolver validates schema, kind, version, hash, permissions, and trust rules where applicable.

## Core Types

AssetRef is a reference stored in a route:

```json
{
  "uri": "asset://local/text/prompt/image-generation/retro-futuristic-editor-joke",
  "kind": "text/prompt",
  "expectedHash": "sha256:...",
  "version": "1.0.0"
}
```

AssetSource is a configured source of assets. Examples:

- `local-folder`
- `embedded`
- `bundle`
- `remote-manifest`
- `github`
- future provider-specific sources

AssetResolver is the host service that resolves AssetRefs into normalized assets.

Normalized Asset is a validated asset object the executor or UI can safely use:

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

## Prompt Asset Example

Prompt Library is a Text Asset source. The human editing surface is local Markdown files:

```text
data/prompt-library/**/*.prompt.md
```

Example:

```markdown
---
id: retro-futuristic-editor-joke
title: Retro-futuristic editor joke
kind: text/prompt
category: image-generation
description: Demo prompt for SnarkRoute
tags:
  - demo
  - easter-egg
---

A retro-futuristic easter egg illustration about building our own visual AI editor with blackjack and courtesans, playful but not explicit, cinematic, detailed, humorous.
```

Discovered prompt files should be normalized into JSON-compatible asset metadata or manifest structures. Do not require manually registering prompt files in code. Do not use one central `prompt-library.json` as the human editing surface.

To add a prompt in the current implementation, create `data/prompt-library/<category>/<id>.prompt.md` with required frontmatter fields `id`, `title`, and `category`, then put the prompt text in the Markdown body. Press `Refresh Prompt Library` in Studio, or call `POST /api/prompt-library/refresh`, to rescan without restarting the server.

## Route Example

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

## Remote Assets

Remote assets are allowed only through configured AssetSources, not arbitrary direct route loading.

Bad pattern:

```json
{
  "type": "library.prompt",
  "params": {
    "url": "https://site.org/prompt.json"
  }
}
```

Good pattern:

```json
{
  "type": "library.prompt",
  "params": {
    "assetRef": {
      "uri": "asset://snarkdream-library/text/prompt/organic-art-nouveau",
      "kind": "text/prompt",
      "expectedHash": "sha256:..."
    }
  }
}
```

The AssetSource named `snarkdream-library` may internally point to `https://site.org/snarkroute/assets.manifest.json`, but the route does not directly fetch arbitrary URLs.

Connection flow:

1. User adds external source.
2. Host downloads manifest.
3. Host validates schema.
4. Host shows available assets.
5. Host checks kind, version, hashes, permissions.
6. Host caches assets if needed.
7. Host warns about changed or missing assets.
8. Host blocks unsafe or unsupported assets.

Example remote manifest:

```json
{
  "schema": "open-route-asset-manifest.v0",
  "sourceId": "snarkdream-library",
  "title": "Snarkdream Asset Library",
  "assets": [
    {
      "id": "organic-art-nouveau",
      "kind": "text/prompt",
      "category": "styles",
      "title": "Organic Art Nouveau",
      "version": "1.0.0",
      "uri": "https://site.org/assets/prompts/organic-art-nouveau.prompt.json",
      "hash": "sha256:..."
    }
  ]
}
```

## Implementation Note

This document describes the target architecture. Implementation should be incremental: first types and docs, then local prompt assets, then resolver, then node integration, then export modes. Do not overbuild remote sources in the first pass.

---

This document is licensed under CC BY-SA 4.0.
