# Custom Nodes

Custom nodes use the same `snarkroute.node` manifest model as bundled nodes.

Install options:

- Drag a `.snarknode` archive onto the Studio canvas.
- Use `Import Node File`.
- Use `Add Node URL`.
- Use `Add Node Library` and select specific nodes.
- Use `Install Local Path` for a development folder.

Installed nodes are copied to `data/installed-nodes/<node-id>/`. Installing locally does not make a node public, global, official, or trusted for other users.

Imported local nodes can be removed from Studio in Settings -> Node Packages -> Manage Installed Nodes. Bundled/core nodes cannot be removed from there.

Routes store node ids, params, links, and optional source metadata. They do not embed executor code or secrets.

If a route references a missing or disabled node, Studio preserves the node and connections and shows a missing-node warning. Deleting an installed node that is already used in the current route preserves the route data; those canvas instances become missing-node placeholders until the node package is installed again or the user removes the instances manually.
