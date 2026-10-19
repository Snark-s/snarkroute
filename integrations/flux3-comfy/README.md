# FLUX.3 Image Klein INT8 for SnarkRoute

State: **integration staged; GPU generation not yet verified.**

The SnarkRoute adapter is in `apps/server/src/providers/flux3-comfy.ts`.
The unified image executor handles `executionProvider: "flux3_comfy"` and
`providerModelId: "flux-3-image-klein-int8"`. A dedicated
`flux3.comfy.generate` node is enabled only when its API workflow path is set.

## Prerequisites

1. Install/update an official ComfyUI build supporting **FLUX.3 Image Klein**
   (not FLUX.2 Klein). Run it bound only to loopback, default port 8188.
2. With your own Hugging Face account, explicitly accept the gated
   `black-forest-labs/flux-3-image-klein-comfy` license. No automation may
   consent to licensing on the owner's behalf.
3. Download the distilled INT8 triple from the gated repo into ComfyUI's
   standard model directories:

   ```powershell
   hf download black-forest-labs/flux-3-image-klein-comfy diffusion_models/flux3_image_klein_sd_int8_convrot.safetensors text_encoders/qwen3vl_4b_int8_convrot.safetensors vae/flux2-vae.safetensors --local-dir "C:\\ComfyUI\\models"
   ```

   Set the target to the **actual** ComfyUI installation folder. Files are
   approximately 5.8 GB + 4.9 GB + 0.3 GB. Ensure adequate free disk space.
   No upsampler is required for the first generation.
4. Load a **FLUX.3-specific** graph in ComfyUI, verify it executes, and
   export its **API format** JSON. Place that trusted graph at a local path.
   Replace input values in the API graph with whole-value placeholders:
   - `{{prompt}}` for text caption (required).
   - `{{seed}}`, `{{steps}}`, `{{width}}`, `{{height}}` for numeric parameters.
   - `{{image1}}` ... `{{image10}}` in LoadImage filenames, if the graph
     explicitly supports that many images.
   - Graph must contain SaveImage or PreviewImage.
   - The graph itself must select the INT8 FLUX.3 transformer, Qwen3-VL
     INT8 encoder and FLUX2 VAE. Do not point it at FLUX.2 weights.
   - Distilled defaults are **16 steps, no CFG**.

## SnarkRoute configuration

Add to the existing locally managed SnarkRoute environment (without changing
other provider configurations):

```text
FLUX3_COMFY_URL=http://127.0.0.1:8188
FLUX3_COMFY_WORKFLOW_PATH=Y:\\Процесс\\SnarkRoute\\integrations\\flux3-comfy\\workflow.api.json
```

Place your validated exported API graph at that path. Restart SnarkRoute.
Choose **FLUX.3 Image Klein INT8 (Local)** in the image model picker, or use
the dedicated `flux3.comfy.generate` node if shown.

The adapter uploads local PNG/JPEG/WEBP references to the ComfyUI input
directory through `/upload/image`, submits the graph to `/prompt`, polls
`/history/{prompt_id}`, reads the completed image via `/view`, and writes
the result to the normal SnarkRoute route assets directory. It never sends
prompts or images to a cloud inference provider.

## Verification checklist

- Local ComfyUI `GET /system_stats` answers successfully.
- ComfyUI model list contains all three weights.
- The exported API graph runs once directly on the GPU.
- `corepack pnpm --filter @snarkroute/server test -- flux3-comfy`
- `corepack pnpm --filter @snarkroute/server build`
- Restart SnarkRoute only after tests pass.
- Verify a single 512x512 text-to-image generation before multi-reference.

## Outstanding blocker

At integration time the gated license had not been accepted via a verified
owner session. SnarkBridge rejected local process execution without a one-use
owner approval. No downloads, GPU jobs, ComfyUI installation, build, test run,
or SnarkRoute restart was performed.

Do not mistake these source changes for a successfully running model.
