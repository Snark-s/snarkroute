# MiniMax H3 production architecture

Status: 2026-09-27. This document distinguishes implemented routing from GPU- or provider-validated behavior. A capability is not called visually verified merely because its serializer, loader, or endpoint works.

## Provenance and model roles

| Catalog variant | Owner / nature | Production role | Runtime | License / availability |
| --- | --- | --- | --- | --- |
| `h3_max_turbo` | fal post-training of MiniMax H3; not an official downloadable MiniMax checkpoint | Fastest hosted preview | fal `minimax/h3-max-turbo/*` | Hosted commercial API; weights unavailable |
| `h3_max` | fal post-training of MiniMax H3; not 10Eros and not an official MiniMax checkpoint | Motion, timing, audio, first/last-frame and native camera check | fal `minimax/h3-max/*` | Hosted commercial API; weights unavailable |
| `h3_base` | Logical base route. The official SGLang partition is `MiniMaxAI/MiniMax-H3`; the current 16 GiB `matlow_int8` local-fast transformer is a pinned MATLOWAI fused H3 derivative and reports its own revision | FL2VA/Ref2VA, semantic reference conditioning and final context | SnarkRoute worker / official hosted regeneration | MiniMax H3 Community License |
| `10eros_max_turbo` | TenStrip community beta5 consensus/graft derivative; hybrid Turbo weights baked into the checkpoint | Local preview on a 16 GiB-class GPU | Shared local H3 runtime | MiniMax community license plus derivative licenses |
| `10eros_max` | TenStrip community beta5 consensus/graft derivative | Local quality experiment | Shared local H3 runtime | MiniMax community license plus derivative licenses |
| `faceswap_ref2va` | UntMods LoRA for the official H3 Ref2VA transformer | Optional identity-transfer modifier and diagnostic control | Applied per job to `h3_base`; never a catalog model | Apache-2.0 |

Pinned upstream data:

- Official H3: `MiniMaxAI/MiniMax-H3@42ed227ee7df40d41602854ae760620d6eb651fe`.
- 10Eros-Max: `TenStrip/10Eros-Max@8a198588c8870ab0d613b3492a3150d091c8c2dd`.
- FaceSwap: `UntMods/FaceSwap_MiniMaxH3_REF2VA@b2a5823ca64bc78d91725fbfcc576095bfceb764`.
- Camera prompt reference: `NyckM/3d-Camera-control-H3-Minimax@36c4218a2561328436d440fa9134631ee515471b`, Apache-2.0. SnarkRoute independently implements the portable concepts; it does not run the published ComfyUI node or workflow.

`H3 Max` and `H3 Max Turbo` are fal products. `10Eros-Max` is a separate community project whose similar name does not imply a common owner or checkpoint lineage beyond both deriving from H3.

## Capability matrix

`API` means the current upstream schema explicitly exposes it. `Local verified` means a real project GPU run exists. `Unverified` is deliberately not advertised as a proven visual capability.

| Variant | T2V | I2V / FL2V | Ref2VA / multi-ref | Audio | Identity LoRA | Camera | 2K | Typical steps / VRAM |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H3 Max Turbo | API | API, first/end/both | No reference endpoint | Native output and `target_audio_url` API | No | Prompt fallback | 1080P latent refinement, not H3 2K regeneration | Hosted; provider-managed |
| H3 Max | API | API, first/end/both | API: up to 9 images, 3 videos, 3 audio, 12 total | Native output, target audio and reference audio API | No | Native resident adapter for orbit/elevation/distance | 1080P latent refinement, not H3 2K regeneration | Hosted; provider-managed |
| H3 Base route | Official upstream + local derivative paths | Upstream; local T2VA, 10 s FL2VA and first/last verified | Local Picture, 2/3 Pictures, Video and Picture+Video GPU-tested; semantic role balance is limited | Official 32 kHz stereo; local generated audio verified; local audio-reference input disabled | GPU-verified on the local fused path; frontal transfer works, profile transitions are limited | Prompt fallback locally; Video framing/motion verified | Official `video_regeneration` 2K endpoint | Local-fast derivative: 4; official final: 20–40 and large weights/offload |
| 10Eros Max Turbo beta5 W4A8 | Loader/API path implemented | Shared FL2VA path | Shared visual Ref2VA path, visual fidelity not separately proven | Native generated audio path; author recommends LCM/simple for Turbo audio | No | Prompt fallback | No distinct 2K model | 4–6 (6 default); ~14.0 GB file; recommended 16 GiB local option |
| 10Eros Max beta5 W4A8 | Loader/API path implemented | Shared FL2VA path | Shared visual Ref2VA path, visual fidelity not separately proven | Native generated audio path; full-step audio preferred by author | No | Prompt fallback | No distinct 2K model | 6–8 `res_multistep/simple` (8 default); ~14.0 GB file |

The current worker correctly leaves `style_transfer=false`. The fixed-seed S0/S1/S2 run on 2026-09-27 verified semantic identity/appearance conditioning but did not transfer stained-glass material, leaded edges, or rendering language. This is a model-capability limitation in the tested path, not evidence of a broken SnarkRoute reference pipeline.

### H3 Base Ref2VA capability detail (2026-09-27 GPU controls)

| Capability | Status | Evidence |
| --- | --- | --- |
| Picture reference | verified | S2 changed face, hair, makeup and object appearance at fixed prompt/seed |
| Multiple Pictures | limited | R2/R3 delivered 2/3 ordered tensors; Picture 1 dominated and requested semantic role separation was weak |
| Video reference | verified | V1 retained head-turn timing, pose path, framing and static camera from A0 |
| Picture + Video | limited | PV1 preserved video motion/framing; Picture appearance was weaker than the video identity |
| Audio reference | unsupported locally | Worker rejects audio reference input explicitly; native generated audio remains available |
| Mixed visual references | limited | Image+video conditioning and generation succeeded, but dominance/role balance is not controllable |
| Subject identity | verified | S2/R2/R3 visibly transferred the short-haired identity from Picture 1 |
| Appearance reference | verified | Hair, facial structure, makeup and clothing treatment changed consistently |
| Motion reference | verified | V1/PV1/F0/F1 tracked the source performance |
| Camera/framing reference | limited | Source framing/static camera were retained; this is not native geometric CameraPath control |
| Native artistic style transfer | failed | S1/R2/R3 remained photoreal and did not adopt stained-glass material/line language |
| FaceSwap modifier | verified, limited | F1 changed frontal identity at strength 1; profile/transition consistency was weaker |
| LoRA cleanup | verified | F0 and post-LoRA F2 were byte-identical without restarting the worker |

## Production route

The Model Gateway publishes provider-neutral H3 variants. Provider filenames, Hugging Face repositories, fal endpoint names, tokens and loader details remain server-side.

1. `h3_max_turbo`: fast draft.
2. `h3_max`: motion, timing, soundtrack, keyframe and native-camera check.
3. `h3_base`: Ref2VA/multi-reference/identity conditioning and final context pass.
4. Official MiniMax `video_regeneration` with `resolution=2K`: high-resolution final pass.

Every node result is a normal SnarkRoute video asset (`localPath`, filename and MIME type), so it can be connected to the next route node without a manual download/import cycle. Local and hosted outputs preserve provider/model/endpoint/job provenance. The existing H3 Studio queue remains backward compatible with saved schema version 1; new camera and identity fields are optional.

Presets and defaults are represented by catalog variants and UI roles: `h3_max_turbo/preview`, `h3_max/motion_check`, `h3_base/reference_final`, official `2k_final`, `10eros_max_turbo/local_fast`, and `10eros_max/local_quality`.

## Reference semantics and the style investigation

SnarkRoute no longer has to infer that every image is the same kind of reference. `H3Reference` distinguishes keyframe roles (`firstFrame`, `lastFrame`), semantic references, target audio, and purposes (`subject`, `identity`, `appearance`, `style`, `motion`, `audio`). The provider adapter rejects combinations that a concrete endpoint cannot represent.

The traced local path is:

`H3 Studio / route input → Model Gateway → H3 request conditions → worker upload → RGB image or decoded video preprocessing → MiniMaxH3ReferenceToVideo → conditioning + latent → per-job transformer → sampler`.

Images are EXIF-corrected RGB tensors normalized to `[0,1]`. Full video references are decoded at 24 fps, limited to 15 seconds and a 512 px long edge. Motion-only video is reduced to a 192 px grayscale blurred guide. The reference is therefore not silently replaced by a first frame or discarded. The likely issue is capability semantics: a subject/style image accepted by Ref2VA is not proof of a dedicated global style-transfer mechanism.

The UI continues to disable “stable style transfer.” The 2026-09-27 A/B/C acceptance run used only base H3 Ref2VA, one neutral prompt, seed 424242, `res_multistep/simple`, four steps, 960×544 and five seconds. S1 (stained glass) remained photoreal while S2 transferred the reference identity/appearance. The correct product label is therefore visual/appearance reference, not style transfer. No Max/Turbo result can promote this capability.

## FaceSwap / Identity Transfer

The artifact is a small Ref2VA LoRA, not a model, face encoder, style adapter, or 10Eros component:

- file: `SS_FaceSwap_MiniMax_H3_REF2VA.safetensors`;
- size: 65,623,904 bytes;
- SHA-256: `1e032cf519cc143f434e67516d8ad0aacf4c6e146315b2dcc3b1c2800470326d` (verified against the pinned Hugging Face LFS object and the downloaded file);
- rank: 16, BF16, 176 tensors / 88 LoRA pairs;
- targets: `attn.qkv_proj`, `attn.out_proj`, `mlp.fc1`, `mlp.fc2` in selected transformer blocks;
- trigger: `Faceswap`; default strength: `1.0`;
- intended base: `minimax_h3_ref2va`.

The worker requires the logical `h3_base` route, Ref2VA, at least one reference video, and an image explicitly marked `purpose=identity`. It inserts the trigger if absent. Compatibility with the current MATLOWAI fused local-fast transformer was GPU-verified on 2026-09-27: F1 at strength 1 changed identity while preserving motion and framing. Transfer was strongest when the face became frontal and weaker across profile/turn transitions, so fidelity remains limited. The model manager downloads only the pinned allow-listed artifact, reports source/revision/size/progress, reuses the Hugging Face cache for resume/deduplication, and verifies exact size and SHA-256.

The headless worker loads the LoRA into a freshly loaded per-job transformer patcher. It records artifact/revision/checksum/strength/trigger in result metadata. The transformer and LoRA patch are unloaded before VAE decode; ordinary exceptions and CUDA OOM also run full unload, GC and CUDA cache cleanup, preventing contamination of the next normal job. The runtime imports pinned Comfy core only as a Python model library; it does not run the ComfyUI server, graph runtime, GUI, workflows, or third-party custom nodes.

The useful upstream-compatible control was completed: F0 plain Ref2VA and F1 FaceSwap + identity B used the same prompt, source video, identity image, seed and parameters. F1 visibly moved toward identity B while retaining the source performance. F2 repeated F0 immediately after F1 without a restart and was byte-identical to F0, proving that the dynamic LoRA patch did not contaminate the next job.

## Provider-neutral CameraPath

Schema version 1.0 stores normalized keyframe time plus an orbit projection today, without preventing later 6DoF:

```yaml
schemaVersion: "1.0"
interpolation: smooth       # linear | smooth
loopClosure: auto           # auto | off
startHold: 0.1
endHold: 0.1
subjectBox: { x: 0.2, y: 0.15, width: 0.5, height: 0.7 }
keyframes:
  - time: 0
    orbit: { azimuth: 0, elevation: 0, distance: 1 }
    position: { x: 0, y: 1, z: -3 }
    target: { x: 0, y: 1, z: 0 }
    orientation: { yaw: 0, pitch: 0, roll: 0 }
    lens: { focalLengthMm: 50, fieldOfViewDegrees: 39.6 }
  - time: 1
    orbit: { azimuth: 360, elevation: 0, distance: 1 }
```

Top-level `azimuth/elevation/distance` remains accepted as a compact compatibility form. `subjectBox` is a normalized target hint and never triggers automatic crop/zoom. The H3 Studio editor supports Auto/Native/Prompt mode, add/remove keyframe, Linear/Smooth, loop closure, holds, normalized subject-box values, and static/orbit-left/orbit-right/orbit-360/rise/fall/dolly-in/dolly-out presets.

Smooth sampling uses monotone cubic Hermite/PCHIP-style slopes so holds and reversals do not overshoot. Angles such as 350°→10° unwrap to 350°→370° (short path), while an explicit 0°→360° is preserved as a full turn. Auto loop closure compares the first and final pose after angular wrap and requires matching elevation/distance. The schema already carries XYZ position/target, yaw/pitch/roll and lens data for future truck, pedestal, crane, pan, tilt, roll, look-at and fly-through providers.

There are two distinct adapters:

- Native H3 Max adapter → `minimax/h3-max/camera-controls`; exactly one first-frame image and up to native orbit/elevation/distance trajectory fields. Unsupported 6DoF and subject-box fields are retained in the asset and returned as warnings, not misrepresented as native support.
- Prompt adapter → deterministic camera direction compiled from CameraPath for local base H3, 10Eros and Max Turbo, based on the portable concepts in the pinned NyckM project. It is labeled prompt guidance, never geometric conditioning.

Native H3 Max camera schema uses normalized time `[0,1]`, signed azimuth degrees with explicit full turns preserved (up to 32 total turns), elevation degrees and normalized distance. The first pose is held before its time and the last after its time. Native versus prompt visual fidelity, scene preservation and the static/azimuth/elevation/distance/360/mixed matrix still require fal credentials and generation spend.

The data model is ready for external continuous controls: a future TouchDesigner CHOP/OSC/MIDI/websocket recorder can sample, simplify/resample and emit the same CameraPath keyframes without changing saved assets.

## 16 GiB local profile, diagnostics and recovery

For the RTX 3080 Laptop 16 GiB, the recommended selectable derivative is `10eros_max_turbo` beta5 W4A8 (`10Eros_Max_h3_TURBO-hybrid_beta5_w4a8_14gb_optimized.safetensors`, 13,997,668,774 bytes). The quality alternative is `10eros_max` W4A8 (`10Eros_Max_h3_hybrid_beta5_w4a8_14gb_optimized.safetensors`, 13,997,668,758 bytes). Other full/INT8 files remain documented upstream but are not auto-downloaded for this profile.

The worker uses staged loading: reference/text encoding, encoder and VAE unload, transformer/optional LoRA load, diffusion, complete transformer unload, VAE reload/decode. It logs total/free VRAM, allocator state and resident components before/after key stages, LoRA apply and full unload, plus peak process/system RAM and swap. Swap growth over the configured 12 GiB limit interrupts the job. CUDA OOM and ordinary runtime errors unload all partial components, clear CUDA cache and reset interruption state so a later job can proceed.

The 2026-09-27 controlled suite completed 10/10 jobs at 960×544, 124 frames and four steps. Per-job time ranged from 362.4 s to 1171.8 s; allocator peaks were 2.37–3.48 GiB and are not total board occupancy because DynamicVRAM/Aimdo owns allocations outside that counter. Every output was a valid MP4. Worker metadata now records reference counts/order/source IDs, preprocessing tensor shapes, encoder/conditioning slot, conditioning and latent shapes, model mode, sampler/scheduler, flow shifts and modifier provenance without serializing tensor values.

## Automated and visual acceptance

Weight-free automated coverage includes request/reference separation, hosted endpoint selection, capability rejection, server-only credentials, FaceSwap constraints and metadata pinning, CameraPath validation, PCHIP sampling, angle unwrap, loop closure, presets, queue persistence defaults, Model Gateway manifests/routing, model catalog entries and worker recovery paths.

Completed locally on 2026-09-27: base H3 A/B/C Picture investigation; 2/3 Picture mapping; Video and Picture+Video; plain Ref2VA versus FaceSwap + identity B; and FaceSwap ON → OFF contamination control.

Visual acceptance still required when the appropriate resources are available:

1. H3 Max native camera: static, ±azimuth, ±elevation, distance 0.8/1.2, 360° and mixed path; compare native versus prompt fallback with identical input and seed.
2. Hosted Turbo→Max route and official 2K regeneration with live credentials.
3. Separate visual fidelity checks for local 10Eros beta5 W4A8 variants; loader compatibility alone is not a quality claim.

Stable artistic style transfer remains failed/unsupported in the tested base path. Identity transfer is verified but limited on profiles/transitions. Native-camera fidelity remains unverified.
