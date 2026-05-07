# Node Library Manifest

A node library lists installable node package URLs. SnarkRoute previews the library and installs only the nodes selected by the user.

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

Node URLs may point to manifest JSON files or portable `.snarknode` archives.
