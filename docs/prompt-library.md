# Prompt Library

Prompt Library is the first user-facing example of SnarkRoute's Asset System. It is a Text Asset source, not a special standalone route feature.

## Local Files

The default folder is:

```text
data/prompt-library/
```

Prompt files use:

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

These files are for human editing. Internally, discovered files should be normalized into JSON-compatible asset metadata or manifest structures. Prompt files should not be manually registered in code, and `prompt-library.json` should not be the primary editing surface.

## Node Shape

The Prompt Library node stores only an AssetRef:

```json
{
  "id": "prompt1",
  "type": "library.prompt",
  "params": {
    "assetRef": {
      "uri": "asset://local/text/prompt/image-generation/retro-futuristic-editor-joke",
      "kind": "text/prompt"
    }
  }
}
```

The node must not store:

- `mode: "linked"`
- `mode: "embedded"`
- `embeddedText` as a node mode
- direct file paths
- direct prompt URLs

## Execution

`library.prompt` asks AssetResolver to resolve `params.assetRef`. The resolved asset must be `text/prompt` or a compatible text asset kind.

The node outputs:

```json
{
  "text": "<resolved prompt text>"
}
```

The node does not know whether the prompt came from a local `.prompt.md` file, generated manifest, remote manifest, embedded route asset, exported bundle, or future provider.

---

This document is licensed under CC BY-SA 4.0.
