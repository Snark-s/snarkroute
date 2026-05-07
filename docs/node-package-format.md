# Node Package Format

A portable SnarkRoute node package is a zip-compatible archive with extension `.snarknode`.

Required root file:

```text
manifest.json
```

Optional files:

```text
executor.ts
ui.schema.json
README.md
examples/example.route.json
assets/
```

Archives are validated before installation. Absolute paths, path traversal, `.env`, `node_modules`, excessive file counts, and oversized packages are rejected.

Folder packages are used during development. Portable archives are used for drag-and-drop, file picker install, URL install, and library installs.
