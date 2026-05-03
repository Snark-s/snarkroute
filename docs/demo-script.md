# SnarkRoute Demo Script

## Before Recording

- Start the local server and Studio.
- Make sure the Replicate token is configured in `.env` or Studio Settings.
- Do not show the token on screen.
- Keep `data/runs/` closed unless showing only generated demo outputs.

## Demo 1: Text Route

Route:

```text
input.text -> replicate.model -> output.file
```

Show:

1. Open Studio.
2. Add or load a text input route.
3. Set a short prompt.
4. Add a Replicate model node and choose a small/fast model.
5. Add an output file node.
6. Validate the route.
7. Run the route.
8. Show logs, run id, node statuses, and the saved output path under `data/runs/<runId>/`.

Expected result:

- The run succeeds.
- The Replicate prediction id is visible in run output/accounting metadata.
- The output file is written locally.

## Demo 2: Clarity Upscaler Image Route

Route:

```text
input.image -> replicate.clarity-upscaler -> preview.image -> output.file
```

Show:

1. Add `Input Image`.
2. Choose or drag a local image.
3. Add `Clarity Upscaler`.
4. Connect the image port from `Input Image` to `Clarity Upscaler`.
5. Set main parameters:
   - `prompt`: `masterpiece, best quality, highres`
   - `scale_factor`: `2`
   - `creativity`: `0.25`
   - `resemblance`: `0.8`
   - `num_inference_steps`: `18`
6. Add `Image Preview`.
7. Add `Output File` only if you want to show explicit route artifact saving.
8. Run the route.
9. Show the image preview and the downloaded asset path under `data/runs/<runId>/assets/`.

Expected result:

- The image input is read locally.
- Replicate returns a prediction.
- SnarkRoute downloads the first output image locally.
- The preview node shows the local result.

This document is licensed under CC BY-SA 4.0.
