# H3 Ref2VA capability test — 2026-09-27

Ten controlled local GPU jobs completed successfully on the RTX 3080 Laptop 16 GiB. The tested logical route was `h3_base`, local MATLOWAI fused INT8 revision `8a8dffaa0cd99c6184833ae0a3b4e9b0089c17b3`, 960×544, 124 frames / 5 seconds, seed 424242, four `res_multistep` steps, `simple` scheduler, basic guidance, video/audio sigma shifts 12/3.

## Result

- Picture reference works for subject identity and appearance. It reliably changed face, hair, makeup and object appearance.
- Video reference works for performance, pose timing, framing and camera behavior.
- Picture + Video reaches the model and renders, but Video identity/motion can dominate the Picture.
- Two and three Pictures reach conditioning in stable numbered order; semantic role separation is limited.
- Native artistic style transfer was not observed. A stained-glass reference did not transfer glass material, leaded edges, abstraction, or rendering language in S1, R2 or R3.
- `UntMods/FaceSwap_MiniMaxH3_REF2VA` is a LoRA modifier, not a separate model. At upstream strength 1 it visibly transferred frontal identity while preserving the source motion/framing; profile/transition consistency was limited.
- FaceSwap cleanup is proven: F0 and F2 (OFF after ON, no restart) have identical SHA-256 and SSIM 1.0.

## Capability matrix

| Capability | Status |
| --- | --- |
| Picture | verified |
| Multiple Pictures | limited |
| Video | verified |
| Picture + Video | limited |
| Audio reference | unsupported locally |
| Mixed visual references | limited |
| Subject identity | verified |
| Appearance | verified |
| Motion | verified |
| Camera/framing from Video | limited |
| Native artistic style transfer | failed |
| FaceSwap modifier | verified, limited |
| LoRA cleanup | verified |

## Evidence

The ignored local artifact directory is `apps/server/data/h3-ref2va-eval/2026-09-27-ref2va-capabilities/`. It contains the reproducible `plan.json`, per-test request/input/worker metadata, references and hashes, MP4 outputs, review strips, and `report.html`. Heavy generated media is not committed.

Human review should focus on S0/A0 versus S1/S2, R2/R3 role dominance, V1/PV1 timing, F0/F1 identity during the turn, and the exact F0/F2 match.
