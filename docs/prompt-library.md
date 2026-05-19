# Prompt Library

Prompt Library is the first user-facing example of SnarkRoute's Asset System. It is a Text Asset source, not a special standalone route feature.

In BoojumRoute, `library.prompt` is an executable BlockNode that resolves a prompt asset for a route. In SnarkRoute, prompt content may also appear as an Artifact or as Prompt Chips inside a prompt editor.

Prompt Chips are reusable prompt fragments shown as visual chips. A prompt may be assembled from library prompt chips, inline text, inherited style/context, and references from the current artifact. Prompt chips should be treated as references to reusable prompt fragments, not merely copied text.

Example:

```text
[Style: dark children room] [Task: replace faces] [Negative: no glow] + inline text
```

## Local Files

The default folder is:

```text
data/prompt-library/
```

Prompt files use:

```text
data/prompt-library/**/*.prompt.md
```

To add a prompt now, create a new Markdown file under a category folder:

```text
data/prompt-library/<category>/<prompt-id>.prompt.md
```

Example:

```markdown
---
id: retro-futuristic-editor-joke
title: Retro-futuristic editor joke
category: image-generation
description: Demo prompt for SnarkRoute
tags:
  - demo
  - easter-egg
---

A retro-futuristic easter egg illustration about building our own visual AI editor with blackjack and courtesans, playful but not explicit, cinematic, detailed, humorous.
```

Required fields are `id`, `title`, `category`, and a non-empty Markdown body. Optional fields are `description`, `kind`, and `tags`.

The prompt reference is:

```text
<category>/<id>
```

For the example above, the reference is:

```text
image-generation/retro-futuristic-editor-joke
```

The folder name does not have to match `category`, but keeping them aligned makes the library easier to browse.

After adding or editing files, refresh the library in Studio with the `Refresh Prompt Library` button on a `Prompt Library` node. The server endpoint is:

```text
POST /api/prompt-library/refresh
```

The refresh rescans `.prompt.md` files, so a server restart is not required.

These files are for human editing. Internally, discovered files should be normalized into JSON-compatible asset metadata or manifest structures. Prompt files should not be manually registered in code, and `prompt-library.json` should not be the primary editing surface.

## Block Node Shape

Current MVP routes use linked prompt params:

```json
{
  "id": "prompt1",
  "type": "library.prompt",
  "params": {
    "category": "image-generation",
    "promptId": "retro-futuristic-editor-joke",
    "mode": "linked"
  }
}
```

Embedded prompt text is supported for local fallback and route portability experiments:

```json
{
  "id": "prompt1",
  "type": "library.prompt",
  "params": {
    "category": "custom",
    "promptId": "draft",
    "mode": "embedded",
    "embeddedText": "Local prompt text."
  }
}
```

Target architecture still moves this to `params.assetRef` so exported routes can resolve local files, embedded route assets, bundles, and remote manifests through the same resolver.

The block node must not store direct file paths or direct prompt URLs.

## Execution

`library.prompt` resolves the linked prompt from the local prompt library or returns `embeddedText` when `mode` is `embedded`.

The block node outputs:

```json
{
  "text": "<resolved prompt text>"
}
```

In the target AssetRef architecture, the block node should not know whether the prompt came from a local `.prompt.md` file, generated manifest, remote manifest, embedded route asset, exported bundle, or future provider.

---

This document is licensed under CC BY-SA 4.0.
