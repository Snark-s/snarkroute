# Node Library Manifest

A node library manifest lists installable block package URLs. The serialized manifest keeps legacy `nodeLibrary` and `nodes` names for compatibility with existing `.snarknode` packages and APIs.

Conceptually, a Library is a portable reusable collection. Libraries may contain or reference artifacts, blocks, routes, boards, prompt chips, styles, model presets, and assets. Imports are dependency/reference links, not necessarily physically nested folders, and circular imports are invalid.

SnarkRoute previews the library and installs only the block packages selected by the user.

```json
{
  "kind": "snarkroute.nodeLibrary",
  "schemaVersion": "0.1",
  "id": "example.video-nodes",
  "title": "Example Video Nodes",
  "version": "0.1.0",
  "author": {
    "name": "Example Author"
  },
  "license": "mixed",
  "nodes": [
    {
      "id": "example.kling.videoGenerate",
      "title": "Kling Video Generate",
      "url": "https://example.com/snarkroute/nodes/kling-video.snarknode",
      "version": "0.1.0"
    }
  ]
}
```

Node URLs may point to manifest JSON files or portable `.snarknode` archives. In BoojumRoute product language these installed items are Blocks or tools.
