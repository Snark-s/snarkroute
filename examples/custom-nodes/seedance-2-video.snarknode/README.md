# Seedance 2 Video

Generates a video through the direct Seedance API.

## Inputs

- `prompt` text input, optional. Overrides the node prompt parameter when connected.
- `firstFrame` image input, optional. First-frame image URL for image-to-video.
- `endImage` image input, optional. End-frame image URL for image-to-video.
- `images` image input, optional. Up to 9 additional public image URLs or upstream assets with URL fields.
- `videos` video input, optional. Up to 3 public video URLs or upstream assets with URL fields.
- `audio` audio input, optional. Up to 3 public audio URLs or upstream assets with URL fields.

## Parameters

- `prompt`: prompt stored directly on the node.
- `endpointMode`: `auto`, `text-to-video`, `image-to-video`, or `reference-to-video`.
- `baseUrl`: defaults to `https://api.seedance.ai/v1`; can be overridden by `SEEDANCE_API_BASE_URL`.
- `model`: defaults to `seedance-2.0`.
- `duration`: `auto` or seconds supported by the provider, usually `4` to `15`.
- `resolution`: provider resolution such as `720p` or `1080p`.
- `aspectRatio`: provider aspect ratio such as `16:9`, `9:16`, `1:1`, or `auto`.
- `style`: optional provider style hint.
- `motionPrompt`: optional motion hint, sent as `motion_prompt`.
- `generateAudio`: whether to request native synchronized audio.
- `seed`: optional reproducibility seed.
- `pollIntervalMs`: status polling interval.
- `timeoutMs`: total generation timeout.

Studio renders fixed-choice parameters as dropdowns: endpoint mode, model, duration, resolution, aspect ratio, poll interval, and timeout.

## Output

- `video`: generated local video asset.
- `output`: raw final API response.

## Secrets

Set `SEEDANCE_API_KEY` before running this node.

## Notes

The direct Seedance API accepts reference media as URLs. Local file inputs are rejected unless an upstream node supplies a public URL field.
