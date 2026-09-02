# Seedance 2 Video

Generates a video through official ByteDance cloud products: BytePlus ModelArk for international access or Volcengine LAS for China-region access. A custom Seedance-compatible endpoint can still be used for existing local workflows.

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
- `providerBackend`: optional node override for `SEEDANCE_PROVIDER_BACKEND`. Supported values are `byteplus-modelark`, `volcengine-las`, and `seedance-compatible`.
- `baseUrl`: advanced custom API base URL. Required only for `seedance-compatible`; official backends use their default base URLs unless `SEEDANCE_API_BASE_URL` overrides them.
- `model`: defaults to the official BytePlus ModelArk ID `dreamina-seedance-2-0-260128`. Legacy `seedance-2.0` and `seedance-2.0-fast` values are mapped to the current BytePlus IDs.
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

For BytePlus ModelArk, the node uses the official content-generation task API (`/contents/generations/tasks`) and reads the completed video from `content.video_url`. Custom compatible endpoints retain the legacy `/generate/...` request shape.

## Output

- `video`: generated local video asset.
- `output`: raw final API response.

## Secrets

Choose the backend in Studio settings and set one matching key:

- BytePlus ModelArk: `ARK_API_KEY` or `BYTEPLUS_ARK_API_KEY`. Key console: https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey
- Volcengine LAS: `LAS_API_KEY` or `VOLCENGINE_LAS_API_KEY`. Key docs: https://www.volcengine.com/docs/6492/1799875
- Custom compatible endpoint: `SEEDANCE_API_KEY` plus `SEEDANCE_API_BASE_URL`.

`SEEDANCE_API_KEY` is still accepted as a legacy fallback so older local setups do not break. Third-party aggregators are not treated as official Seedance API key sources.

## Notes

The direct Seedance API accepts reference media as URLs. Local file inputs are rejected unless an upstream node supplies a public URL field.
