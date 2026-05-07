# External Node Package Safety

SnarkRoute validates external node packages before installation and does not execute code during fetch, unpack, preview, or install.

Current safety boundary:

- Plugin nodes receive only env vars declared in `permissions.env`.
- Shell execution is refused in this build.
- Output writes should use SnarkRoute asset helpers.
- Install previews warn about executable code, network, file reads, shell, and env vars.
- Archive paths are checked for traversal and absolute paths.
- `.env`, `node_modules`, and build caches are not packed by the official packer.

Known limitation:

Plugin executors currently run in the Node.js process, not in a hardened sandbox or container. A malicious plugin may still try to access Node.js APIs directly. Install only packages you trust.
