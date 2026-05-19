# BoojumRoute Lab Capabilities

## Executive Summary

BoojumRoute Lab is an experimental graph environment for building AI pipelines from Blocks / BlockNodes. You can connect models, prompts, images, text transforms, and external services into routes that can be run, saved, and extended with custom block packages.

The current implementation is a local-first visual workflow editor plus an execution backend for Open Route Protocol style route documents. The main working capabilities are React Flow canvas editing, typed block/node connections, route import/export, localStorage save/restore, bundled block execution, installed node package management, prompt library support, local asset handling, and execution metadata.

Node is an umbrella term in the broader SnarkRoute model. This capabilities document describes BoojumRoute executable blocks, not SnarkRoute ArtifactNodes.

## User-Facing Studio Capabilities

| Capability | What the user can do | Status | UI |
|---|---|---:|---|
| Canvas editing | Add, move, select, and delete nodes/edges | implemented | Main canvas |
| Node palette | Add nodes by click or drag | implemented | Left sidebar |
| Node categories | Browse grouped node categories | partially implemented | Left sidebar |
| Typed connections | Connect compatible output/input handles | implemented | Canvas handles |
| Add compatible node | Drag from an output and choose a compatible next node | implemented | Floating menu |
| Save / load | Save and load the current project locally | implemented | Toolbar |
| Local restore | Restore a saved route on app load | implemented | Startup |
| Import / export | Import and export `.orp`, `.route`, JSON/YAML | implemented | Toolbar, drag/drop |
| Installed nodes | Install, enable, disable, inspect, and uninstall node packages | implemented | Settings |
| Missing-node placeholders | Preserve unknown/disabled/uninstalled nodes as placeholders | implemented | Node card warning |
| Compound / subroute | Collapse part of a graph into an internal subroute | implemented | Toolbar/context menu |
| Logs / results / preview | Inspect logs, JSON results, and previews | implemented | Bottom panel, nodes |
| Route execution | Validate and run a full route or selected nodes | implemented | Top bar/node controls |

## Route / Graph Model

- Supports `.orp`, `.orp.json`, `.orp.yaml`, `.route`, `.route.json`, `.route.yaml`, and plain JSON/YAML.
- Nodes include `id`, `type`, `title`, `params`, `inputs`, `outputs`, `compound`, `capability`, `subroute`, `nodePackage`, and `ui`.
- Edges include `from`, `to`, `fromPort`, `toPort`, and optional `id`.
- Typed ports are implemented in Studio and manifests.
- Validation covers schema, duplicate IDs, missing endpoints, selected built-in types, and node-package availability.
- Compound nodes use `type: "compound.subroute"` with an embedded `subroute`.

## Block / Node System

- Built-in bundled blocks include text/file/image/video inputs, capability nodes, prompt library, image preview, template transform, debug log, HTTP request, local Stable Diffusion, and text/file outputs.
- Provider bundled blocks run server-side through adapters.
- Installed local block packages live under `data/installed-nodes`.
- Node manifests use the `snarkroute.node` format with permissions, executor, ports, params, and metadata.
- Node library import supports `snarkroute.nodeLibrary`.
- Plugin blocks call an executor module through `runNode(context)`.
- Declarative HTTP blocks run through `declarative.http`; generic `declarative` still needs clarification.

## Execution

- Execution order is built through topological sort and cycle detection.
- Template interpolation supports expressions like `{{nodeId.output.path}}`.
- Compound node execution runs the embedded subroute.
- Logs and results are collected per run and per node.
- Provenance and cost usage are stored as metadata.
- Output files and generated/downloaded images are written into run folders.

## Current Limitations

- The palette has no full search yet.
- Dirty state has no persistent visible indicator.
- Compound port editing is still rough.
- Server-side project storage has not replaced browser localStorage yet.
- Studio visuals should be checked in a live browser before important demos.
