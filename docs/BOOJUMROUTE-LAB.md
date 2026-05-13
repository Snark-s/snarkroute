# BoojumRoute Lab

BoojumRoute is the low-level graph/tool-building layer.

The existing Studio/graph UI is preserved as BoojumRoute Lab. It is the place for advanced users and developers to build tools from blocks, routes, providers, executors, schemas, prompt library assets, and installed packages.

## Concepts

- Block: the BoojumRoute-facing name for old route nodes.
- Block graph: the editable graph of executable blocks.
- Tool route: a route used as an internal tool pipeline.
- Installed block/tool: an installed `.snarknode` package or manifest, still stored in the old compatible node package format.
- Compound tool route: the BoojumRoute-facing concept for old compound/subroute nodes.
- Provider: an adapter to an external or local execution system.
- Executor: the runtime mechanism that runs a block.

Neural networks are one kind of executor/provider behind a tool route. They are not the core product model.

BoojumRoute creates tools that SnarkRoute can later expose as actions on the Living Canvas.

## Compatibility

Open Route Protocol and `.snarknode` package fields still use node terminology. That is intentional for compatibility with saved routes, examples, tests, and installed packages.
