# Export Modes

Linked, embedded, and bundle are export modes, not node params.

## Linked Export

Linked export keeps AssetRefs in the route. The exported route depends on compatible AssetSources being available in the importing host.

Use this when the route should stay small and continue pointing at a known local or external asset library.

## Embedded Export

Embedded export resolves selected assets during export. Resolved assets are embedded into the route document, and route references are rewritten to embedded asset URIs or equivalent internal references.

Use this when a single route file should carry the selected assets needed for execution or review.

## Bundle Export

Bundle export packages the route and assets together:

```text
my-route.orp.zip
  route.json
  assets.manifest.json
  assets/
    text/
      prompt/
        image-generation/
          retro-futuristic-editor-joke.prompt.md
```

Bundle export keeps route structure clean while making the package portable.

## Diagnostics

Export should report unresolved assets before writing the final artifact. Future tests should cover:

- linked export keeps AssetRefs
- embedded export embeds resolved assets
- bundle export includes asset files and manifest
- export diagnostics for unresolved assets
- import handling for embedded and bundled assets

---

This document is licensed under CC BY-SA 4.0.
