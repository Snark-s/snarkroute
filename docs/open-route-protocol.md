# Open Route Protocol

Open Route Protocol is a portable route format for describing AI/model/API workflows as graphs.

Routes can reference external assets, but only through the AssetRef system. The host application controls how asset references are resolved, validated, cached, embedded, bundled, or blocked.

In v0.1, serialized route `nodes` represent executable BlockNodes. The broader product terminology treats Node as an umbrella term that also includes ArtifactNodes on SnarkRoute boards. See `docs/terminology.md`.

Current specification notes live in `docs/open-route-protocol-v0.1.md`.

---

This document is licensed under CC BY-SA 4.0.
