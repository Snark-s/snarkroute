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

This first pass only reserves the interface and minimal shared types. It does not implement generation, external AI calls, persistence, or complex artifact/card logic.

See `docs/terminology.md` for the shared terminology model.
