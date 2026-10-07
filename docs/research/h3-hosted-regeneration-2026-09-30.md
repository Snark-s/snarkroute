# Hosted MiniMax H3 Regeneration — one controlled test, 2026-09-30

**The official MiniMax endpoint accepted the existing fal-generated MAX-I1 MP4 and returned a real 2560×1440 result. Exactly one create POST was sent, with no retry or new source generation.** Test: HOSTED-REGEN-MAX-I1-2K; task: 447391378309467. Technical compatibility/render verified for this source and conditioning. Production audiovisual finalizer remains unverified.

Review limit: all 124 original/output frame pairs were visually inspected through eight ordered atlases, plus native pixel crops. Both clips fully decoded offline. Browser security policy rejected opening the local file: comparison page; no workaround was attempted. Continuous perceptual playback and audio listening were **not verified**. Subtle full-resolution flicker/crawling and semantic sound cues/sync remain open. Waveform measurements do not substitute for listening.

## Official API and exact request

[Official regeneration schema](https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration), including its Markdown OpenAPI representation, was checked before submission. Endpoint: POST https://api.minimax.io/v2/video_regeneration; model: MiniMax-H3. Video mode requires model, content and 2K resolution. Optional callback/watermark fields were omitted. Original final prompt and matching references accompany exactly one base video. Prompt limit: 40,000 characters; body: 64 MB. Source requires audio, 24 fps, dimensions divisible by 32, area 589,824–1,032,192 pixels and 107–362 frames on a 17-frame cadence (approximately 4–15 seconds). Alternative account-task mode requires eligible owned, queryable recent tasks; fal's job ID was never used as a MiniMax task ID.

References must match original inputs. Original first image was forwarded; no last-frame/video/audio references were used originally. Media limits were checked against the [create schema](https://platform.minimax.io/docs/api-reference/video-generation-v2-create). Accepted tasks were [polled](https://platform.minimax.io/docs/api-reference/video-generation-v2-query) by the existing client. Documentation retrieval times/hashes are in run.json.

```json
{
  "model": "MiniMax-H3",
  "content": [
    { "type": "text", "text": "<exact original final MAX-I1 prompt>" },
    { "type": "image_url", "image_url": { "url": "<original JPEG data URI>" }, "role": "first_frame" },
    { "type": "video_url", "video_url": { "url": "<unchanged MAX-I1 MP4 data URI>" }, "role": "base_video" }
  ],
  "resolution": "2K"
}
```

Body: **6,474,206 UTF-8 bytes**. request.json preserves exact prompt/structure, actual body SHA/size, source/reference hashes and representation, with base64 payloads redacted. Existing createH3RegenerationClient inline transport and download were used. No separate upload: upload result null; source asset ID is a SHA content address for evaluation, not a newly registered server upload. Credentials are absent from artifacts.

## Environment, source and conditioning

Server apps/server/src/index.ts calls services/env-loader.ts:loadRootEnv(). server-paths.ts resolves **Y:\Процесс\SnarkRoute\.env**; dotenv config uses override:false, so inherited variables take precedence. apps/server/.env is not read by this loader. No env file was created/modified by the agent. Execution followed the user's “готово”.

Original: fal / fal/minimax-h3-max; job 01a0e48c-d255-7df2-a10e-9fcbb4e5ac7d; apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-I1/output.mp4. SHA verified:
`ed5dc65e35c27707655cf025b2e9a6cf36fdabdb8ebe9708adf7875db467e8f9`.

Exact original final prompt came from that run's request.json: portrait, profile-to-front turn, slow push-in, stable key/warm rim, quiet studio/fabric/breath/shutter sound. Expansion disabled, expanded prompt null. Original inputs/first.jpg (960×544, 28,093 bytes) was forwarded without transformation; current SHA:
`8e4ebdcfd28e987cc154605fdbaf51a9dd52c60bc030f67bbddc26efdba898ab`.
**Historical image SHA was not saved**, so historical byte identity cannot be cryptographically proven; limitation recorded before submission.

All hard source checks passed: readable MP4/size, audio, dimensions/area, exact packets/frame count, cadence and body/image limits. Source was not transcoded. Frames: 124 = 107 + 17.

## Acceptance, timing and cost

Create accepted HTTP 200; task succeeded. No rejection reason. [Provider result](https://video-product.cdn.minimax.io/inference_output/rollout/2026-09-30/bb6af2ca-28be-45b2-9c85-784e8c1fe2ef/output_aigc.mp4).

| Event | UTC, 2026-09-30 |
|---|---|
| Submission | 14:42:25.620 |
| Accepted response observed | 14:42:31.187 |
| Completion observed | 14:44:42.073 |
| Download start / end | 14:44:42.074 / 14:44:46.699 |
| Finished | 14:44:46.797 |

Generation observed: **130.886 s** from accepted response to success observation. End-to-end: **141.177 s**, including download **4.625 s**. These are client observations with polling delay; Moscow time is UTC+3.

[Official pricing](https://platform.minimax.io/docs/pricing/overview): output $0.05/s. Preflight estimate **$0.2592** from source container 5.184 s. One image fits the first five free; original reference-video/audio input estimate $0.00. Provider usage: total_seconds=5, input_seconds=0, output_seconds=5, input_image_count=1. Postflight output/total estimate **$0.25**. Measured output duration gives $0.25835 instead; reported usage is the postflight basis. Actual billing absent: **estimated / invoice unverified**, actual USD null.

## Output metadata

| Property | Original MAX-I1 | Regenerated 2K |
|---|---:|---:|
| Dimensions | 1344×768 | **2560×1440** |
| FPS / exact frames / video packets | 24 / 124 / 124 | 24 / 124 / 124 |
| Video duration | 5.166667 s | 5.166667 s |
| Container / audio duration | 5.184 s | 5.167 s |
| Codec / video bitrate | H.264 / 7,266,870 bit/s | H.264 / 2,739,928 bit/s |
| Audio | AAC stereo 32 kHz | AAC stereo 32 kHz |
| Audio bitrate / packets | 178,780 bit/s / 163 | 132,326 bit/s / 163 |
| File bytes | 4,826,842 | 1,862,280 |

Output SHA:
`837a7b7b3185c0340096657f4a760f895bf1e71941816351c37f64d4851a8f70`.

## Content, identity, motion, detail and temporal quality

It looks like regeneration of the same clip: face appearance, hair placement/color, black blouse, earrings/pendant, head turn/blink timing, push-in, studio stands/background and broad lighting remain consistent across inspected pairs. No conspicuous new objects, face/hair mutation or background jumps at atlas scale. Identity is a visual assessment, not a biometric guarantee.

Framing is not pixel-identical: aspect **1.75 → 1.777778 (+1.5873%)**. Atlases normalize geometry to 448×256; originals/native crops retain their geometry. Motion progression and cadence match. Supporting successive-frame-difference correlation 0.99423 is not a perceptual quality score.

Native frame-62 crops show sharper-looking eye/lip/hair boundaries in 2K, with smooth skin. No prominent sharpening halos there. Natural skin pores, fabric weave and background microdetail improvement are **not established**. Video bitrate falls despite more pixels. Higher resolution alone cannot prove improved detail. Subtle invented texture, aliasing/compression, flicker and crawling require full-size playback. Contact columns: frames 0/31/62/92/123 at 0/25/50/75/100%; last frame starts at 5.125 s.

## Audio inspected separately

Audio **not dropped**, but not bit-preserved: encoded AAC packet hashes and decoded samples differ. Decoded samples/channel at 32 kHz: 165,888 vs 165,333. Audio/container shorter by **17 ms**; video duration/cadence unchanged.

20 ms RMS envelope correlation **0.998764**; dominant transient window centers match **4.67 / 4.77 / 4.87 s**. Zero-aligned channel correlations 0.81896/0.70690. General timing is closely preserved. Changed AAC bitrate/bytes and similar envelope are **consistent with re-encoding**, an inference rather than provider-confirmed pipeline behavior. Audio regeneration cannot be ruled out categorically. Room tone, breath/fabric/shutter identity and perceptual sound-to-action sync are **unverified without listening**. Three transient peaks do not establish three semantic shutter clicks.

## Conditioning fidelity and capability

No conditioning ablation was performed. This test used the original prompt and first image; it cannot separate each input's effect, prove tolerance for missing inputs, or generalize to other reference modes.

Before: Configured · unverified after key setup; external fal source unverified. After: **technical hosted render verified for this exact MAX-I1 base_video + original prompt + first_frame scenario**. Actual acceptance/schema compatibility/2K output are established. Arbitrary MP4 support and production audiovisual fidelity are not.

Scoped verification/lineage are in run.json and metadata.json. No broad UI Verified badge was added. A finalizer for eligible H3 Max output is plausible, but requires continuous viewing/listening and evaluation of the detail tradeoff. No new paid test or optimization pipeline was built.

## Changes and focused checks

Changes: original-reference forwarding and body-size validation in the existing regeneration adapter; controlled evaluation runner with preflight/audit/cost/timing/provenance and exclusive persistent submission lock; offline review script; MP4 ignore rule; report/artifacts. No Local/MATLOW/Base/Max generation/Turbo/LoRA/FaceSwap/CameraPath/generic upscale/Decision/Auto routing changes in this hosted task.

Before live call: adapter **30 tests passed** (12 new); evaluation **6 passed**; existing server regeneration service **2 passed**; H3 TypeScript build passed. Coverage: serialization, prompt/references, external-source validation, pricing, polling/download/ingestion/provenance, insufficient balance/rejections, no retry, concurrent/repeated reservation refusal. Offline script fully decoded both clips with two ffmpeg threads and no inference. Focused syntax/diff checks pass; AST-only graph update performed.

**Do not rerun --execute or remove submission-lock.json.** The one-create budget is spent. Lock/second-POST refusal remain on success, rejection and uncertain failures. Raw replies in provider-result.json.

## Results and what to inspect

Directory: apps/server/data/h3-hosted-regenerate-eval/2026-09-30/.

- run.json, request.json, provider-result.json, metadata.json, submission-lock.json.
- output.mp4, thumbnail.jpg, review-strip.jpg, contact-sheet.jpg, comparison.html.
- Eight temporal-review atlases covering every frame, two native face-crop PNGs, audio-waveform.jpg, review-measurements.json.

MP4 ignored by Git. Open **comparison.html locally**: relative videos need no API server. Play both entire clips; listen to each separately with audio-selection buttons; inspect native crops and late sound cues. This remaining human review is required before calling the result a production finalizer.
