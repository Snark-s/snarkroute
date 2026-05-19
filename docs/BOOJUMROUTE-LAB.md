# BoojumRoute Lab

BoojumRoute is the process-authoring layer.

The existing Studio/graph UI is preserved as BoojumRoute Lab. It is the place for advanced users and developers to build tools from blocks, routes, providers, executors, schemas, prompt library assets, and installed packages.

## Concepts

- Node: an umbrella term for a generic graph item. In BoojumRoute, most traditional route nodes are BlockNodes.
- Block / BlockNode: the BoojumRoute-facing name for an executable operation or process block.
- Block graph: the editable graph of executable blocks.
- Tool route: a route used as an internal tool pipeline.
- Installed block/tool: an installed `.snarknode` package or manifest, still stored in the old compatible node package format.
- Compound tool route: the BoojumRoute-facing concept for old compound/subroute nodes.
- Action: the SnarkRoute-facing invocation of a BlockNode or Boojum route, often shown as a contextual button on an Artifact card.
- Provider: an adapter to an external or local execution system.
- Executor: the runtime mechanism that runs a block.

Neural networks are one kind of executor/provider behind a tool route. They are not the core product model.

BoojumRoute creates Blocks and Routes that SnarkRoute can later expose as Actions on the Living Canvas. A Boojum compound route/block maps naturally to a SnarkRoute action button.

## Compatibility

Open Route Protocol and `.snarknode` package fields still use node terminology. That is intentional for compatibility with saved routes, examples, tests, and installed packages. This compatibility wording does not mean every visible SnarkRoute object is a Boojum process node; SnarkRoute creative objects are Artifacts.

See `docs/terminology.md` for the shared terminology model.
