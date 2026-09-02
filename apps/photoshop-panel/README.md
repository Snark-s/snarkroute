# SnarkRoute Photoshop UXP panel

This is a loadable UXP Manifest v5 scaffold for Photoshop 25+. It discovers portable tools from SnarkRoute and implements the host-critical selection boundary: bounds planning, composite capture, exact grayscale selection-mask capture, and non-destructive raw-pixel placement on a new layer with that mask.

Build with `corepack pnpm --filter @snarkroute/photoshop-panel build`, then load this directory in UXP Developer Tool. The panel intentionally does not enable remote execution yet: the current shared tool job returns encoded media, while `imaging.putPixels` requires decoded `PhotoshopImageData`. The `RawPixelResult` contract in `src/host.ts` is the explicit boundary for the next adapter step; it prevents a lossy rectangular paste from being presented as selection-safe behavior.

See [`../../docs/adobe-host-adapters.md`](../../docs/adobe-host-adapters.md) for the two selection modes, exact-mask behavior, context padding, current limitations and Adobe API references.
