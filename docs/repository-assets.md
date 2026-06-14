# Repository Asset Policy

Updated: 2026-06-14

## Current Large Tracked Assets

Largest tracked assets in the reviewed asset folders:

| Path | Approx size |
| --- | ---: |
| `docs/videos/snarkroute-clarity-demo.mp4` | 16.0 MB |
| `data/prompt-library/styles/prompt-1778328938009.preview.png` | 9.8 MB |
| `data/prompt-library/styles/000-generation.png` | 6.3 MB |
| `data/prompt-library/character-reference/charactercard.preview.png` | 3.3 MB |
| `data/prompt-library/character-reference/prompt-1779028277407.preview.png` | 3.2 MB |
| `data/prompt-library/000-generation.png` | 2.3 MB |
| `data/prompt-library/character-reference/prompt-1780834685791.prompt.png` | 2.2 MB |
| `data/prompt-library/image-generation/360-panorama.preview.png` | 2.0 MB |
| `data/prompt-library/character-reference/facs-style-facial-expression-reference-grid.preview.png` | 2.0 MB |
| `docs/images/360.png` | 2.0 MB |
| `docs/images/SnarkRoute1.png` | 1.3 MB |
| `docs/images/SnarkBudjum.png` | 1.2 MB |

The working tree also contains larger runtime artifacts under `apps/server/data` and `data/runs`; those should remain uncommitted runtime output.

## Forward Policy

- Prefer WebP/JPEG previews under 400 KB where visual fidelity allows.
- Keep source-quality images only when they are reference material, not generated previews.
- Store demo videos outside git or add future videos through Git LFS from the start.
- Do not migrate existing history or force-push to retrofit LFS.
- Do not commit generated run outputs, local screenshots, cache files, or `apps/server/data` runtime artifacts.

## Future Cleanup

- Review each large `data/prompt-library/**/*.preview.png` for references before compression or removal.
- Replace large PNG previews with WebP/JPEG derivatives only when the source/reference quality is preserved elsewhere.
- If videos become part of regular docs, add `.gitattributes` for future `docs/videos/*` additions before committing new videos.
