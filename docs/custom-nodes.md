# Custom Nodes

Custom nodes use the same `snarkroute.node` manifest model as bundled nodes.

Install options:

- Drag a `.snarknode` archive onto the Studio canvas.
- Use `Import Node File`.
- Use `Add Node URL`.
- Use `Add Node Library` and select specific nodes.
- Use `Install Local Path` for a development folder.

Installed nodes are copied to `data/installed-nodes/<node-id>/`. Installing locally does not make a node public, global, official, or trusted for other users.

Routes store node ids, params, links, and optional source metadata. They do not embed executor code or secrets.

If a route references a missing or disabled node, Studio preserves the node and connections and shows a missing-node warning.
