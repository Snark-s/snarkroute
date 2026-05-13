# SnarkRoute Living Canvas

SnarkRoute is the future creative interface.

In SnarkRoute, a node is an idea, entity, or concept. It is not a low-level executor block.

## Model

- Node: an idea/entity/concept on the canvas.
- Card: one concrete variant inside a node.
- Stack: the set of candidate cards inside a node.
- Active card: the selected candidate variant for a node.
- Inputs: other nodes, active cards, pinned cards, or context used to create or modify a node.
- Context: style, atmosphere, world, format, and other inherited creative direction.
- Tools: actions supplied by BoojumRoute/tool runtime.

## Behavior Direction

Style and context are inherited until changed. A node can receive local inputs and inherited context at the same time.

Modifiers add candidate cards to an existing node. Extractors and converters can create new nodes. Service actions may prepare, inspect, or transform data without changing the semantic canvas structure.

This first pass only reserves the interface and minimal shared types. It does not implement generation, external AI calls, persistence, or complex node/card logic.
