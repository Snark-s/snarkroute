# PUREPHOTO SPAN CONTROLLED RUN — 2026-10-04

**SPAN execution и comparison SUCCEEDED.** Выполнен ровно один CUDA neural job; retry, warmup, settings sweep, другие модели и downloads: **0**. Vimeo inference и существующие Original/Vimeo normalized не повторялись. GameUp не запускался. Suitability/winner остаётся за пользователем.

## Precheck и provenance

GPU free выше configured threshold8192 MiB; available RAM выше4096 MiB. Stale benchmark worker PIDs: **[]**, порт8092 свободен, active.lock отсутствовал до acquisition. Точные precheck readings записаны в [continuation-summary.json](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-span/continuation-summary.json). Источник SHA-256 `ed5dc65e35c27707655cf025b2e9a6cf36fdabdb8ebe9708adf7875db467e8f9`, integrity проверена до submission и после обработки.

- Model: `framewise/4x-purephoto-span`, PyTorch/Spandrel, framewise, context1, native4×, CUDA. Weight `4xPurePhoto-Span.pth`, pinned **9016490 bytes**.
- Weight SHA-256: `c689eec59771ed3eaffc10eea933c44fdb9131f83251c51c5bab4cae7c4d3bf2`. Size и SHA совпадают с inventory; модель не скачивалась.
- Job ID: `vup_9dd1c060-3409-48e1-97c2-ff1c87755839`; submission attempts **1**.
- Exact settings: tile256/overlap32 input pixels, chunk1/overlap_frames0, scale4, devicecuda, audiocopy; libx264 medium CRF18, YUV420P, 24fps, GOP48/keyint48/scenecut0.
- License: **CC-BY-SA-4.0**. GameUp CC-BY-NC-SA-4.0 restriction сохранена; его execution не выполнялся.

Старая precheck-only BLOCKED попытка SPAN без job/native сохранена в `controlled/history/span-blocked-before-2026-10-04/`; старый `span.attempt.json` не удалён. Новое явное разрешение использует новый `span-2026-10-04.attempt.json` и тот же global active.lock. Harness разрешает такую continuation только для BLOCKED без job/submitted-job/native; FAILED или уже выполненный job повторно не запускаются этим режимом.

## Resource policy и isolation

Inference policy не расширена: process CPU guard180%, total CPU guard85%, sustained interval10с, RAM4096MiB, VRAM precheck8192MiB/runtime512MiB. CPU affinity mask3: максимум два logical CPUs для worker/children и harness. FFmpeg decode/encode/filter threads2, OMP/MKL/OpenBLAS/NumExpr≤2, torch intra2/inter1. **Runtime device CUDA**, CPU model fallback не применялся; CPU preprocessing/blend/encode остаются частью pipeline.

В inference harness выполнен native-only stage. После сохранения native, bounded shutdown и validation отдельный media stage использовал разрешённый guard200%, ту же affinity/остальные protections. Это изменение review policy, не inference. Fresh worker завершился **DELAYED_CLEAN**, returncode0; final owned active count0, порт8092 закрыт, VRAM postcheck пройден. UNCLEAN/UNKNOWN не подавлялись. Последующий comparison тоже завершил все owned процессы; active.lock снят. Внешние процессы не завершались.

## Execution и performance comparison

| Metric | SPAN 4×, текущий job | Vimeo 2×, прежний job |
|---|---:|---:|
| Native resolution | 5376×3072 | 2688×1536 |
| Frames / FPS | 124 / 24 | 124 / 24 |
| Worker startup | 1.627 с | 1.623 с |
| Cold model load | 11.823 с | 12.251 с |
| Total processing wall | 299.485 с | 227.959 с |
| Inference wrapper | 260.366 с | 207.077 с |
| Model forward | 103.459 с | 194.325 с |
| Processing seconds / second video | 57.96 | 44.12 |
| Torch allocated / reserved peak | 251.57 / 290.00 MiB | 5217.03 / 9616.00 MiB |
| Sampled system GPU used peak / free minimum | 2617 / 13559 MiB | 11643 / 4533 MiB |
| GPU utilization sampled range | 1–50% | 4–100% |
| Owned CPU sampled peak, 100%=one core | 187.95% | 177.65% |
| Total system CPU sampled peak | 62.02% | 69.26% |
| Owned RSS sampled peak | 4.407 GiB | 2.195 GiB |
| Available system RAM sampled minimum | 10.085 GiB | 12.706 GiB |
| Native bytes | 19777252 | 6517030 |
| Neural harness wall | 309.777 с | 234.684 с |

Denominator — actual video124/24 =5.1667с, не длина AAC5.184с. SPAN processing примерно **1.314×** дольше. Это не quality score; разное время запуска и внешняя GPU нагрузка ограничивают прямое performance comparison. System GPU memory не равна model allocation; torch peak не включает CPU blend buffers, encoder и прочие system allocations.

SPAN preprocessing1.992с, postprocessing8.004с, decode pipe wait0.782с, encode pipe wait1.903с, encoder finalization wait24.071с, audio mux0.135с. Forward/pre/post измеряются внутри tile runtime; inference wrapper также включает tiled accumulation/blend и другие операции вне этих phase scopes. Поэтому суммы не обязаны совпадать. Piped decode/encode waits не являются codec compute times. Inference135 samples примерно каждые2с — sampled observations, не exhaustive peaks. Intermittent CPU peak187.95% выше guard180%, но sustained10с не достигнут: guard не отключался.

Media comparison wall83.207с, включая normalization33.696с и triple render23.263с; это отдельные postprocess times, не neural inference. Media35 samples: owned CPU peak192.61%, total CPU peak40.19%, owned RSS peak1.104GiB, available RAM minimum13.260GiB, system GPU used peak2126MiB. Graphify AST update выполнен после timed inference/media stages, с affinity максимум два logical CPUs.

## Native, normalization, audio и color

Native сохраняется отдельно: **5376×3072**,124frames/24fps/SAR1/H.264/YUV420P. FFprobe подтвердил BT.709 primaries/transfer/space и range`tv`. Native SHA-256 и metadata записаны в summary. Source без color tags продолжает трактоваться как **TEST ASSUMPTION: SDR BT.709 limited**, не как измеренный source fact. Decode explicit limited709→fullRGB; model RGB; encode fullRGB→limited709. Gamma/contrast/saturation не менялись.

Normalized SPAN: native5376×3072 → Lanczos2520×1440 → pad20px left/right → **2560×1440**, SAR1, без crop/stretch. То же libx264 medium CRF18/24fps/GOP48/YUV420P/BT.709 profile, что у existing Original/Vimeo. Normalized SHA-256: `a33898e56e239cb2bf7b9a94f6c519f7b54404ffa7200c7163b5ba5e8a8b8153`; **4358636 bytes**.

Original AAC stereo32kHz скопирован без re-encode и без`-shortest`. Native/normalized/triple comparison сохраняют **163 packets**, одинаковую ordered packet-size/hash sequence: `05779dbc6e656cb2b6a246dc13e4fef030d9b37dbf4a74936b189036ed098802`. Existing Original/Vimeo normalized SHA остались неизменными; повторно выполнены только metadata/audio checks, не render.

## Материалы и preliminary observations

Finished contact sheet: **три строки без placeholders** × frames0/31/62/92/123. Native crops девяти областей для Source1×/Vimeo2×/SPAN4×: eyes/lashes/brows, nose/lips, jaw/skin edge, hairline, hair strands, visible left earring, pendant, blouse edge, background stand. Coordinates fixed, не landmark-tracked. Native PNG и sheets —1:1 без resampling; большие листы браузер может fit-to-window, для оценки открыть individual PNG at100%.

Дополнительно matching **normalized1:1** eye/hair crops кадра62: у всех моделей одинаковые pixel dimensions, без resize. Это позволяет сравнивать detail на одинаковом final canvas, не путать размер4× с полезной детализацией.

Предварительный static review пяти normalized кадров и selected frame62 crops:

- Явного прироста полезной микродетализации относительно Vimeo не видно. В matching normalized crops SPAN сглаживает отдельные ресницы/границы бровей и тонкие пряди волос; Vimeo сохраняет больше различимых мелких линий в просмотренном кадре.
- Native4× увеличивает изображение, но inspected eye/hair/skin crops остаются мягкими; увеличение размеров не доказывает восстановление новых достоверных деталей.
- Крупного изменения формы глаз/носа/губ/челюсти/hairline на пяти выбранных кадрах не заметил. Это preliminary static observation, не complete identity assessment.
- В inspected vertical/horizontal frame62 blend crops нет заметного жёсткого seam. No obvious strong halos/new pore pattern на просмотренных crops; сглаживание заметнее sharpening. Это не подтверждает отсутствие артефактов в других областях/кадрах.
- **Temporal shimmer/flicker/crawling NOT_ASSESSED:** непрерывный normal-speed просмотр автоматически не выполнен. Local browser automation не поддерживает`file://`; обход политики не выполнялся. Adjacent-frame MAD сохранён только как diagnostic, не motion-compensated и не quality score. Пользователю смотреть **1× first**, затем0.5×/0.25×, проверять eyes/hair/jewelry/background и tile bands. Suitability/winner не выбран.

SPAN tile starts actual runtime: X`[0,224,448,672,896,1088]`, Y`[0,224,448,512]`,24tiles/frame. Edge overlap bands шире номинальных32px: lastX64px, lastY192px. Overlay отмечает **actual blend locations**, не detected seams; navigation images явно labelled resized, seam PNG crops остаются native4×1:1. Дополнительных neural runs для этого не было.

Triple full-speed MP4: Original слева / Vimeo в центре / SPAN справа, каждый panel1280×720, overall**3840×720**,124frames/24fps/BT.709 limited/AACcopy; **4383550 bytes**. Для деталей использовать full-size2560×1440 players и native crops, не уменьшенные panels.

## Verification и artifacts

**46 focused tests passed**, без model loads/CUDA: explicit blocked continuation preserves history, RAM precheck, SPAN comparison refuses unsuccessful/already existing stage, existing CPU override/benchmark/temporal/pipeline/registry tests. Все local HTML media/href targets проверены, native/normalized metadata/audio identity и source/model/output SHA checked. Graphify AST update завершён; зависимости не устанавливались. No full-repo build: изменения ограничены Python harness/review scripts и focused tests.

- [Original normalized](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/normalized/original.mp4)
- [Vimeo normalized](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/normalized/vimeo.mp4)
- [SPAN native](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/span/native.mp4)
- [SPAN normalized](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/normalized/span.mp4) · [Validation](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/normalized/span-verification.json)
- [Review HTML](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-span/index.html)
- [Contact sheet](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-span/contact-sheet-normalized.jpg)
- [Native crops index](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-span/native-crops/index.json) · [Matching normalized crops](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-span/normalized-crops/verification.json)
- [Full-speed comparison](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-span/full-speed-comparison.mp4)
- [Tile geometry](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-span/tile-seams/geometry.json)
- [Inference result](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/span/result.json) · [Request](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/span/request.json) · [Inference resource samples](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/span/resource-samples.json)
- [Comparison verification](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-span/verification.json) · [Summary](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-span/continuation-summary.json)

**STOP AFTER SPAN:** следующих candidates, GameUp, дополнительных SPAN passes/settings changes не запускать без нового разрешения.
