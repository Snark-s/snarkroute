# Adobe host adapters

After Effects CEP and Photoshop UXP use the same portable tool schema, SnarkRoute API, statuses, selection semantics, and server-side validation. Host APIs remain behind small adapters; model/provider rules do not live in either panel.

## After Effects

`apps/after-effects-panel` contains the React panel and pure schema/job logic. `jsx/host.jsx` is the narrow ExtendScript boundary.

The current-frame flow is:

```text
saveFrameToPng -> POST /api/assets/import -> create job
-> import that PNG as placeholder source -> poll
-> download result -> import footage -> replaceSource(imported, false)
```

The placeholder is no longer a gray solid. It uses the exact exported PNG (or captured current frame for a selected source), starts at the source composition/time and carries a job id in layer comment and marker metadata. A small text/overlay identifies generation without decorative animation. Legacy solid placeholders remain replaceable.

Replacement uses the existing `replaceSource(..., false)` path, so timing, transform, masks, effects, parenting, markers, blending and other layer properties remain on the layer. Extra variants are imported as project items and do not destroy the primary result. Temporary captures are removed only when they live under the SnarkRoute AE temp directory and are no longer used; user files are never cleanup targets. Failed/cancelled placeholders retain readable metadata for diagnosis/retry.

Schema-derived AE sources currently implemented are current, first and last composition frames and a manual image/video/audio file. Work-area rendering and true selected-footage frame extraction are reported as unsupported instead of silently using a wrong source. Published tool jobs expose progress, cancellation, result selection and the H3 `Regenerate in 2K` next stage.

CEP/ExtendScript calls cannot be executed in Vitest. Pure metadata/replacement/state logic has unit tests; final verification still requires a real AE host.

## Photoshop

`apps/photoshop-panel` is a Manifest v5 UXP scaffold targeting Photoshop 25+. It follows Adobe's current UXP model: document mutations run inside `executeAsModal`, while the Imaging API transfers pixels and masks.

Two modes are explicit:

- **Replace selection**: capture the composite plus exact selection mask and context, then place decoded result pixels on a new layer at the capture origin and apply the original grayscale mask. Pixels outside the original selection remain hidden; the source layer is not changed.
- **Use selection as input**: capture selection material as an input while allowing the result to become a separate image/layer.

Bounds planning clamps to the document, supports very small/edge selections, and defaults `contextPadding` to 20% of selection dimensions. `imaging.getSelection` supplies the real grayscale mask, preserving feathering, partial opacity, holes and complex contours rather than reducing it to a rectangle. Capture metadata retains color profile and component depth so a future decoder can make an explicit conversion decision.

The current scaffold deliberately stops at `RawPixelResult`: SnarkRoute tool jobs return encoded media, while UXP `imaging.putPixels` requires decoded `PhotoshopImageData`. Until a tested UXP decoder/converter is added, the panel does not pretend to perform a selection-safe remote paste. Capture, placement planning and exact-mask application are implemented and unit-tested; end-to-end execution and Adobe-host behavior are not yet verified.

Relevant Adobe primary documentation:

- [UXP Manifest v5](https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-guide/uxp-misc/manifest-v5/)
- [Selection class](https://developer.adobe.com/photoshop/uxp/ps_reference/classes/selection/)
- [Imaging API](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/imaging/)
- [executeAsModal](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/executeasmodal/)

## Adding another host

Implement four boundaries: schema capability filtering, host capture to typed assets, common API/job client, and semantic output placement. Keep field coercion, padding/bounds and placement planning pure and testable. If a source or placement cannot be honored exactly, exclude the tool with a diagnostic rather than substitute another behavior.
