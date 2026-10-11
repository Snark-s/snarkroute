# H3 experimental still images and X2 VAE (local MATLOW)

Source projects (independent, community-built):
- Fizgig stills: https://github.com/shootthesound/ComfyUI-Fizgig-H3-Still (MIT). Our implementation is headless and uses the pinned ComfyUI *core library* only.
- X2 Detail VAE: https://huggingface.co/speach1sdef178/MiniMax-H3-X2-Detail-VAE (MiniMax H3 Community License; review conditions for commercial use).

## Opt-in features

H3 Studio → **Fizgig Still / X2 VAE** panel. H3 Studio's existing video composer and its default VAE remain unchanged.

- **Fizgig Still:** one-frame H3 latent and a 5-latent replication during VAE decode (pixel frame 3), saved as PNG. Optional picture goes through H3 Ref2VA conditioning. This is image generation, not extracting a frame from an MP4. Preview, H3 Base only.
- **X2 Video:** normal H3 diffusion, then the **experimental** 12-channel packed RGB X2 VAE, H3-specific tiled decoder (256 / 64) and PixelShuffle x2. Saved as MP4. Preview, H3 Base only. X2 decode cannot be substituted for a standard 3-channel VAE, nor can it be combined with still mode until separately tested.
- **B32 Detail**: The additional RGB reference-enhancement branch published by the author is *separate* from X2 video decoding, requiring true original RGB and early encoder features. This branch has NOT been wired to the H3 Studio pipeline. X2 video alone does not promise reconstructed true details.

Worker request options:
- `output_mode: "video" | "still"` (default video)
- `vae_mode: "stock" | "x2"` (default stock)

The SnarkRoute model adapter, local worker, H3 queue and UI propagate these fields. User data and existing VideoUpscale jobs are unaffected. A no-checkpoint fail-closed error is returned if X2 is selected without verified weights.

## Pinned weights

`/home/serge/h3/models/speach1sdef178/MiniMax-H3-X2-Detail-VAE/MiniMax-H3-X2-Detail-v1.safetensors`

Pinned HF revision: `af8c92d267c6849fec5032c35a65d5766737b338`.

Byte count: `5246877148`.

SHA-256: `2296840f4acedcaa976688e7d7b97f7bf570b136e400385d3f46224011897aac`.

The repository's untrusted ComfyUI custom-node ZIP and workflow have been retained for reference but are not imported, executed, or installed into the production worker.

## Verified tests

- Python compileall and Pydantic payload loading: PASS.
- H3 adapter/server/Studio production TypeScript/Vite builds: PASS.
- RTX 3080 Laptop GPU 16 GiB / PyTorch 2.13 CUDA 13 / DynamicVRAM: synthetic 256×256 true still decode and 512×512 X2 decode PASS, finite pixels, no OOM.
- Authenticated real 4-step H3 still run: succeeded at 960×544 in PNG; worker job `af7f004d-22f4-440c-bcac-73be8dbc0a4d`. Output copied to `Y:\Процесс\Test\H3-Experimental-20261011\h3-fizgig-real-still.png`.
- Authenticated real X2 run: test job `baf05ce1-d773-42cb-baaf-b7a98032af65` (confirm its final status before treating as verified).

Do not interpret a successful synthetic decode as proof of subjective improvement. Controlled, identical-seed A/B should check native-resolution baseline, X2 decode, and a conventional external upscale.

## Rollback

Before replacing any WSL worker files, copies were saved under `/home/serge/h3/runtime/local/backups/h3-experimental-20261010T220855Z`. SnarkBridge creates per-file rollback backups for all guarded edits within `I:\SnarkBridge\workspace\bridge_backups\snarkroute\`.

Old defaults are stock video; no automatic X2 activation. To roll back fully, stop the local H3 worker, restore the six source files from that WSL backup, re-run the pinned launcher and build the previous frontend revision. Avoid git clean/reset because user has unrelated uncommitted work.
