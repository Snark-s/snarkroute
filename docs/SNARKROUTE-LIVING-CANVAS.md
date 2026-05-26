# SnarkRoute Living Canvas

SnarkRoute is the object/workspace layer and future creative interface.

In SnarkRoute, Node is an umbrella term for a generic graph item. It is not only a low-level executor block. Visible creative objects should preferably be called Artifacts in the UI.

## Model

- Artifact / ArtifactNode: a user-facing creative object on a board, such as an image, video, audio, text, prompt, mask, reference, or generated output. It is not executable by itself.
- Block / BlockNode: an executable operation or process block, usually authored in BoojumRoute.
- Board: the editable visual workspace/composition containing artifacts, optional block nodes, relations, layout, groups/comments, versions/stacks, action history, provenance, and selected libraries/imports.
- Card: one visible presentation of an Artifact or one concrete variant inside an Artifact stack.
- Stack: the set of candidate or version cards inside an Artifact.
- Active card: the selected current version for an Artifact.
- Inputs: other artifacts, active cards, pinned cards, attached references, or context used to create or modify an Artifact.
- Context: style, atmosphere, world, format, and other inherited creative direction.
- Action: a user-facing invocation of a BlockNode or Boojum route, usually shown as a contextual button on an Artifact card.
- Prompt Chip: a visual reference to a reusable prompt fragment that can be combined with inline text, inherited context, and current artifact references.

## Behavior Direction

Style and context are inherited until changed. An Artifact can receive local inputs and inherited context at the same time.

Modifiers add candidate cards or versions to an existing Artifact. Extractors and converters can create new Artifacts. Service actions may prepare, inspect, or transform data without changing the semantic canvas structure.

## Directory Model

Living Canvas is a view of directories, not a container that owns otherwise hidden objects.

- A workflow/board is a directory with `snark.library.json` and, for canvas views, `canvas.json`.
- An image Artifact node is a directory referenced by `canvas.json`, currently below `image-nodes/*.imgnode/`.
- The node stack is the node directory's `stack/` contents as indexed by `snark.node.json`.
- The active stack item is the current visual representation of an image-node directory.
- A workflow directory may name its current representative image through `snark.library.json.representativeImage`:

```json
{
  "representativeImage": {
    "nodeId": "image_...",
    "stackItemId": "stack_..."
  }
}
```

This makes a nested workflow presentable as one card/node in a parent canvas while it remains a navigable directory and canvas internally. Collapsing a selection into such a nested workflow is UI behavior; it does not require a new binary container format.

Deleting a node removes it from the canvas and moves its complete directory to `.trash/nodes/` inside the owning workflow directory.

## Current Prompt

Every image-node directory owns its editable current request:

```text
image-nodes/<node>.imgnode/
  snark.node.json
  current-prompt.txt
  stack/
```

`current-prompt.txt` is UTF-8 plain text. It stores the current editor value independently of stack history, including inserted chip tokens. Running generation persists this editable prompt template before invoking a provider; the resolved transmitted prompt is recorded with the generated image. Imported images and new empty image nodes start with an empty file.

### Input Chip Tokens

Connected node chips can be inserted into the editable prompt as stable tokens:

```text
[[text:text_node_id]]
[[image:image_node_id]]
```

- The editor renders an inserted token as the corresponding visual chip thumbnail; chips may be inserted or dragged to any caret/drop position in the prompt. The token text is the persisted transport representation, not the normal editing presentation.
- A text token is replaced at execution time with the current text of that connected text node. A connected text node whose token is not present in the prompt is ignored.
- Image inputs are ordered by the reorderable chip strip and sent in that order, up to the selected model's declared image-input limit.
- Only image nodes connected into the target node are sent as image inputs; the target node's own active stack image is output history, not an implicit input.
- When a model declares an image reference syntax, such as `@image{index}`, an inserted image token is replaced with its transmitted one-based reference, for example `@image1`.
- If an image is beyond the model's declared `maxImageInputs`, its chip is displayed inactive, its image is not sent, and its token resolves to empty text.
- If a model accepts images but does not declare `imageReferenceSyntax`, eligible images are still sent; image tokens resolve to empty text instead of inventing provider-specific syntax.

The UI reads these optional model metadata fields from model catalog records:

```json
{
  "maxImageInputs": 4,
  "imageReferenceSyntax": "@image{index}"
}
```

`maxImageInputs` may also be obtained from `ioContract.inputs[]` where `kind` is `image` and `maxItems` is present.

### Generation Parameters

The parameter summary in an active image-node footer is an editable control for the selected concrete model. It is built from that model's `generationParameters` definition in the server-owned Living Canvas model catalog, rather than exposing one universal image form.

```json
{
  "generationParameters": [
    {
      "id": "aspectRatio",
      "label": "Aspect ratio",
      "type": "select",
      "default": "1:1",
      "options": [{ "value": "1:1" }, { "value": "16:9" }]
    }
  ]
}
```

A model may publish no editable parameters, for example an upscaler whose only supported input is an image. Values from the selected model definition, overridden by optional `defaultParameters` or `defaultParams`, are sent with generation and recorded in the image provenance payload. The server does not inject unrelated generic image parameters.

## Image Provenance Protocol

A generated local stack image may carry the resolved request and complete generation parameter snapshot in the graphical file itself. This is separate from `current-prompt.txt`: changing the node prompt later does not rewrite historical images. When a prompt contained chip tokens, `parameters.promptTemplate` preserves that editable token form while `prompt` is the exact text sent to the provider.

Payload identifier: `snarkroute.image-provenance` version `0.1`.

```json
{
  "format": "snarkroute.image-provenance",
  "version": "0.1",
  "prompt": "A quiet lighthouse at dawn",
  "parameters": {
    "model": "provider/model",
    "providerMode": "auto",
    "prompt": "A quiet lighthouse at dawn",
    "images": [],
    "aspectRatio": "16:9",
    "imageSize": "2K"
  },
  "providerId": "provider-id",
  "modelId": "provider/model",
  "nodeId": "image_...",
  "createdAt": "2026-05-25T00:00:00.000Z"
}
```

`parameters` is the invocation parameter snapshot used by SnarkRoute, including media input descriptors when inputs were supplied. Readers must ignore fields they do not understand and preserve them if rewriting metadata.

### Physical Encoding

| File type | Metadata location | Identifier |
| --- | --- | --- |
| PNG | UTF-8 `iTXt` chunk inserted before `IEND` | keyword `snarkroute.provenance` |
| JPEG | XMP packet in an `APP1` segment | namespace `https://snarkroute.local/ns/image-provenance/0.1/` |
| WebP | `XMP ` RIFF chunk | same XMP namespace |

For XMP carriers, the JSON payload is UTF-8 bytes encoded as Base64 inside `<snarkroute:provenance>...</snarkroute:provenance>`. For PNG, the `iTXt` text value is the JSON payload directly.

Imported files are not rewritten merely because they enter a stack. An image with no provenance payload remains a normal image in the stack. Newly generated images returned as remote URLs are downloaded into their node stack before they are accepted as generation results, so generated history remains locally owned and can carry provenance.

See `docs/terminology.md` for the shared terminology model.
