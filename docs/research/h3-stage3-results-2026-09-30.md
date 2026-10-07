# SnarkRoute H3: Turbo, local 2K, Visual LoRA

Дата закрытия: 2026-09-30. Статус: **completed with blocked local 2K**.

Итог: Turbo T2V/I2V/First+Last работает в трёх контролируемых вызовах; Authentic Cinematic Texture действительно влияет на MATLOW Base, но меняет внешность и амплитуду движения; локальный Regenerate 2K в текущем worker отсутствует. Автомаршрутизация не добавлена. Новых Max-генераций нет.

## Материалы и воспроизводимость

- [Общий run.json: параметры, timings, cost, provenance, SHA-256 и все абсолютные output paths](../../apps/server/data/h3-stage3-eval/2026-09-30/run.json).
- [HTML comparison: 11 роликов с metadata, два contact sheet и блокировка 2K](../../apps/server/data/h3-stage3-eval/2026-09-30/comparison.html).
- [Max ↔ Turbo contact sheet](../../apps/server/data/h3-turbo-eval/2026-09-28-controlled/max-vs-turbo-contact-sheet.jpg).
- [Base ↔ Cinematic contact sheet](../../apps/server/data/h3-visual-lora-eval/2026-09-28-controlled/contact-sheet.jpg).
- [PIPELINE-M2K metadata](../../apps/server/data/h3-stage3-eval/2026-09-30/PIPELINE-M2K/metadata.json).

Offline harness: `node scripts/h3-stage3-report.mjs`. Он перечитывает сохранённые request/metadata, хэширует MP4, пересчитывает temporal metrics и строит JSON/HTML. **Не отправляет API/worker jobs.** Контракт отчёта проверяется `node --test scripts/h3-stage3-report.test.mjs`.

Run directories:

- Max control: `Y:/Процесс/SnarkRoute/apps/server/data/h3-max-eval/2026-09-27-controlled`.
- Turbo: `Y:/Процесс/SnarkRoute/apps/server/data/h3-turbo-eval/2026-09-28-controlled`.
- LoRA: `Y:/Процесс/SnarkRoute/apps/server/data/h3-visual-lora-eval/2026-09-28-controlled`.
- Aggregate: `Y:/Процесс/SnarkRoute/apps/server/data/h3-stage3-eval/2026-09-30`.

В каждой завершённой case-папке: `output.mp4`, `request.json`, `metadata.json`, `thumbnail.jpg`, `review-strip.jpg`. У Turbo также `provider-result.json`. MP4 исключены точечными правилами .gitignore, ничего не staged/committed этой работой.

## A. H3 Max Turbo controlled test

### Официальный контракт

Endpoints:

- `minimax/h3-max-turbo/text-to-video`: T2V.
- `minimax/h3-max-turbo/image-to-video`: first frame, last-only и first+last через `image_url` / `end_image_url`.

Официальные поля: prompt, integer duration 5–15 s, resolution 480P/768P/1080P, seed, prompt expansion disabled/balanced/quality, safety/sync и target_audio_url. Aspect ratio — поле T2V; для I2V не сериализуется. Last-only/target-audio здесь не рендерились. Семантический reference-to-video Turbo endpoint не найден: capability unavailable, endpoint не придуман. Локальные LoRA, FaceSwap, inference steps и CameraPath не отправляются hosted provider.

Источники: [fal T2V schema](https://fal.ai/models/minimax/h3-max-turbo/text-to-video/api), [fal I2V schema](https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api).

### Параметры

Все три: seed **5242017**, 5 s, 768P, 16:9, prompt expansion disabled, один output. Prompt и JPEG first/last взяты из предыдущего Max suite без изменений; hosted prompt просит поворот головы, плавный push-in, стабильное освещение, studio room tone, rustle, breath и shutter после остановки. Полный текст и provenance inputs в plan/request/run JSON.

Один fixed prompt/seed — ограниченный эксперимент, не статистический ranking. Max controls сделаны 27 сентября, Turbo 28 сентября, поэтому различия очереди/сервера не изолированы.

### Результаты и стоимость

| Test | Request id | Accept s | Generation/poll s | Provider total s | Download s | End-to-end s | Quote USD |
|---|---|---:|---:|---:|---:|---:|---:|
| TURBO-T0 | 01a0e901-df3c-70c0-a484-c65e116c240b | 0.564 | 5.277 | 5.841 | 4.656 | 10.497 | 0.20 |
| TURBO-I1 | 01a0e902-0bdd-7531-8317-58102f72ad45 | 0.609 | 2.802 | 3.411 | 2.932 | 6.343 | 0.20 |
| TURBO-FL1 | 01a0e902-2509-7591-b12a-056abc96134a | 0.424 | 4.965 | 5.389 | 3.744 | 9.133 | 0.20 |

Все succeeded. Provider inference metric: 1.405 / 1.555 / 1.525 s соответственно; это **не** полное время queue→result. Review extraction не включён в end-to-end download latency.

Ровно **3 платных вызова**, предварительная quote по $0.20, суммарная **расчётная $0.60**. Actual invoice не получен, эту сумму нельзя называть подтверждённым списанием. Insufficient credits не было; serializer/client tests проверяют non-retryable normalization. Автоматических повторных платных вызовов не делалось.

Текущие list rates: Turbo 480P/768P/1080P ≈ $0.025/$0.04/$0.08 за output second; Max $0.05/$0.08/$0.16. При 5 s 768P это $0.20 vs $0.40. [fal Max/Turbo pricing](https://fal.ai/minimax-h3-max).

В исторических Max metadata записана quote $0.20 и promotion «through 2026-09-30». Это устаревшее предположение нашего estimator; исходные records сохранены без переписывания. Cutoff исправлен на окончание 14 сентября. Aggregate помечает историческую quote stale, current list estimate $0.40 и invoice unverified.

Все шесть hosted outputs: H.264 1344×768, 24 fps, 124 frames; video ≈5.167 s, MP4/audio ≈5.184 s; AAC stereo 32 kHz. Наличие audio stream подтверждено, но качество звука и синхронизация shutter **не прослушаны** — не заявляем audio parity/lip-sync.

### Max ↔ Turbo

Contact-sheet rows сверху вниз: MAX-T0, TURBO-T0, MAX-I1, TURBO-I1, MAX-FL1, TURBO-FL1. Кадры сопоставлены по времени.

В sampled frames Turbo сохраняет замысел head-turn/push-in и first/last conditioning; крупного визуального ухудшения в этом портрете не обнаружено. Мелкие отличия траектории/выражения/света есть; одинаковый seed у двух model variants не обещает идентичный результат. Идентичность между T2V Max/Turbo не является заданной constraint. Для I1/FL1 похожесть endpoints близка.

| Pair | Max mean adjacent-frame luma difference | Turbo | First SSIM Max / Turbo | Last SSIM Max / Turbo |
|---|---:|---:|---|---|
| T0 | 0.976 | 0.918 | — | — |
| I1 | 1.626 | 1.601 | 0.934199 / 0.934203 | — |
| FL1 | 1.826 | 1.700 | 0.934100 / 0.933605 | 0.940506 / 0.939996 |

SSIM: input JPEG resized до 1344×768 против первого/последнего decoded frame; это image similarity, не identity score. Frame-diff: ffmpeg tblend difference + signalstats.YAVG; **не flicker score**. Hard scene cuts при threshold 0.3: 0 у всех шести. No-cut request соблюдён по этой диагностике; непрерывность всех деталей и отсутствие crawling не доказаны.

Исторический Max provider/e2e: T0 1.055/3.412 s (resumed result, не честный generation baseline), I1 5.404/9.144 s, FL1 6.476/8.911 s. I1 Turbo быстрее; FL1 provider быстрее, но download свёл преимущество на нет. Нельзя заключить «Turbo всегда быстрее».

Практическая роль: **preview/draft candidate** с меньшей list cost и близкой картинкой в этой сцене. Для final/identity-critical use нужны более широкие примеры и прослушивание звука пользователем.

## B. Max → LOCAL H3 Base Regenerate 2K

Выбран существующий MAX-I1:

- Provider fal; model `fal/minimax-h3-max`.
- Job `01a0e48c-d255-7df2-a10e-9fcbb4e5ac7d`.
- [Source MP4](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-I1/output.mp4).
- SHA-256 `ed5dc65e35c27707655cf025b2e9a6cf36fdabdb8ebe9708adf7875db467e8f9`.
- Input 1344×768, 24 fps, container 5.184 s.

**Blocked, not run.** MATLOW INT8 local worker advertises `resample.available=false`: H3-Regenerate-2K is outside this checkpoint. The alternative diffusers backend does not supply a working local regenerate path either. Existing `createH3RegenerationClient` uses MiniMax hosted `/v2/video_regeneration`, model MiniMax-H3 and `base_video`, with MINIMAX_API_KEY. That is not local Base finalization.

Дополнительно серверный существующий regenerate service принимает завершённые minimax.h3.generate tool jobs; fal queue result — другой lineage path. Hosted regeneration unit tests не доказывают Max→local acceptance.

Не запускались hosted regeneration, новая Max-генерация или Spandrel/TSCUNet/RRDB. Нет output2K, time, peak VRAM, output duration/fps, content/motion/detail/artifact measurements. Все поля в PIPELINE-M2K — null с reason; источник и requested finalizer сохранены отдельно. Соответственно настоящего Max-original ↔ Base2K изображения нет: HTML показывает источник и явную блокировку.

Production cost formula: source Max list estimate $0.40 + local finalization **unknown**. Практичность цепочки не подтверждена. Чтобы продолжить именно этот эксперимент, нужен совместимый **local H3 Regenerate 2K backend/checkpoint**, не изменение маршрутизации.

## C. Authentic Cinematic Texture Visual LoRA

### Source, безопасность, compatibility

[Civitai](https://civitai.com/models/2890588/minimax-h3-authentic-cinematic-texture): model 2890588, version 3267949 / v1.0, author TuTu_1018, published 2026-08-26, base MiniMax H3.

Exact file `Minimax H3真实电影质感.safetensors`, **309,965,208 bytes**. SHA-256:

`51dda79218ea126cbb2e08f3a6d9cc595e2224f4977d7618061954043a8bafcf`.

[HF mirror metadata](https://huggingface.co/Alex995647/loras-minimax-h3/blob/1517498210f571b0ed956f40df2765078daa749d/minimax-h3-authentic-cinematic-texture/info.txt), repository Alex995647/loras-minimax-h3, pinned revision `1517498210f571b0ed956f40df2765078daa749d`. Artifact lives under nested `minimax-h3-authentic-cinematic-texture/`, not repository root; downloader corrected and tested for this exact remote path.

License: Civitai custom permissions, not SPDX: no-credit allowed, commercial-use flags [Image, RentCivit, Rent], derivatives and different license allowed. Эти флаги сохранены, не заменены выдуманной MIT/Apache license.

Safetensors header: BF16, 516 tensors, rank16; diffusion blocks' adaln_proj.linear, attn.qkv_proj/out_proj, mlp.fc1/fc2 and token_refiner. Совместимая структура найдена в MATLOW/Comfy loader; воздействие подтверждено изменёнными видео, а не только успешной загрузкой.

Verified Base: MATLOWAI fused Turbo INT8 revision `8a8dffaa0cd99c6184833ae0a3b4e9b0089c17b3`; Comfy core `f938505952476e48a12687eac696cdc94d48a3fe`, comfy-kitchen 0.2.31; RTX3080 Laptop16GiB. Только этот checkpoint/T2VA tested. Это не гарантия иных fused variants, FL2VA/Ref2VA или всех H3 loaders.

Windows verified download:
`C:/Users/serge/AppData/Local/SnarkRoute/models/h3/visual-loras/authentic-cinematic-texture-v1/Minimax H3真实电影质感.safetensors`.

Worker verified install:
`/home/serge/h3/models/Alex995647/loras-minimax-h3/Minimax H3真实电影质感.safetensors`.

SHA обеих копий совпал. Только safetensors; third-party scripts, pickle и bundled extensions не запускались. Download verifies size/SHA before atomic install. Файл не превращён в новую «Cinematic Model»: H3 Base + optional Visual Modifier.

Author recommendation: **0.7 default, 0.5 motion**. Structured trainedWords пусты/null, описание упоминает **DY**. Trigger optional/off by default, показан с metadata conflict; controlled A/B не доказал его обязательность. Специальная resolution recommendation не подтверждена — не придумана. Непроверенные example prompts не подменяют production-like test prompt.

### Controlled cases

Все: seed5242017, 5s,16:9,4steps, preview/lossless, T2VA, 960×544,24fps124frames,H.264,AAC stereo32kHz. Sampler res_multistep, scheduler simple, flow video12/audio3, basic guidance, VAE tile256.

Prompt:

> A cinematic medium close-up of a woman in a black blouse standing in a neutral photography studio. She turns slowly from left profile to direct eye contact while the camera performs a gentle push-in. Natural skin texture, restrained contrast, soft window-like key light, subtle warm rim light, realistic lens depth of field, no cuts, no subtitles, no music.

| Stored id / report alias | Modifier | E2E s | Worker render s | Model-load s (not isolated LoRA) | Torch reserved peak GiB | Process RAM peak GiB |
|---|---|---:|---:|---:|---:|---:|
| C0 / C0_base | off | 820.910 | 817.381 | 2.901 | 2.373 | 24.388 |
| C1 / C1_cinematic | 0.7, no DY | 620.734 | 619.115 | 3.945 | 2.588 | 26.503 |
| C2M / C2_motion_strength | 0.5, no DY | 1131.432 | 1128.377 | 2.069 | 2.568 | 20.110 |
| C2 / C3_trigger_test | 0.7, DY | 1466.793 | 1464.786 | 2.912 | 2.588 | 22.813 |
| C0R / C0_reset_control | off after C1/C2 | 710.812 | 708.990 | 5.178 | 2.393 | 21.624 |

Aliases фиксируют отклонение раннего case naming: stored C2 был trigger case, поэтому motion strength сохранён как C2M. Не переименовываем исходные артефакты.

C2M interrupted attempts были до успешного v2; в сравнении только завершённый job 7d2e06cb-e615-436c-9281-f59297a14f2a. Нельзя приписать их завершённым результатам. Launcher MATLOW получил nohup для detached worker, runtime files синхронизированы. Это не доказывает причину каждого внешнего worker shutdown.

### Визуальная оценка

Rows: C0 / C1(0.7 no DY) / C2M(0.5 no DY) / C2(0.7 DY) / C0R.

C0: более глянцевое/контрастное photoreal rendering, прямые длинные волосы, заметный studio/window фон. При 0.7 меняется **вся** сцена: более тёмная мягкая тональность, меньше specular gloss, другой свет/фон; волосы становятся волнистыми с чёлкой, лицо/appearance меняется. Это глобальное visual influence, не локальный detail enhancer и не identity-preserving finalizer.

0.5 ближе к Base: мягче изменения фактуры, длинные волосы/оконный фон ближе исходному, но внешность всё равно не фиксирована. DY не дал очевидного качественного выигрыша в единственном A/B; требование включать его автоматически не подтверждено.

Skin/material texture и specular response субъективно смягчаются; contrast/tonal response меняются. Строгие highlight clipping, shadow detail, grain/noise, MTF/edge sharpness, lens/DOF и texture-crawling измерения не выполнены — различие кадров не равно количественному улучшению. Atmospheric depth/background также меняются вместе с composition.

Head-turn и push-in сохраняются, но motion amplitude выглядит меньше. Mean frame-diff Y: C0/C0R **2.923**, C1 **1.362**, C2M **1.813**, C2 **1.310**. Это общий frame change, не отдельная оценка motion speed/quality. Scene cuts >0.3: 0 во всех пяти. В sampled frames нет грубых распадов лица; отсутствие flicker/temporal artifacts во всех кадрах не доказано. Hands отсутствуют, verdict невозможен. Identity между Base и LoRA **не сохраняется достаточно строго**.

### Lifecycle и performance

Реальная последовательность C0 → C1 → C2 → C0R прошла в одном worker без reset-restart между этими jobs. **C0 и C0R MP4 побайтно идентичны**:

`29aeb82564fd5c1811f516f159a482ae260a3c59f167c1c11a7eddba776ff56a`.

Contamination prevention подтверждена в этой последовательности. Per-job transformer/patcher свежий, unload перед VAE decode; baseline-off не наследует Cinematic. Более поздний C2M не покрыт этим reset comparison.

Torch reserved delta против C0: ≈+0.215GiB при0.7, +0.195GiB при0.5; C1 RAM delta≈+2.115GiB. **peak_vram_gib — torch reserved, не total GPU peak**: dynamic offload allocations не полностью учитываются этим счётчиком. GPU capacity16GiB не означает measured peak16GiB.

Изолированные initial LoRA load и unload/reset times не инструментировались; они unknown. Model-load aggregate не следует выдавать за LoRA load overhead. Сравнение generation wall time сильно зависит от encoder/cache/offload/system memory. Например C2M encoder377.820s, diffusion707.446s, VAE25.360s, swappeak2.877GiB. Нельзя заключить, что LoRA ускоряет throughput по C1<C0 или что DY сам вызвал slowdown.

FaceSwap + Cinematic не тестировались и не включаются автоматически; combination fail-closed в adapter/server/worker/UI. Loader architecture для multiple modifiers не переделана.

### Capability и дальнейшая роль

Visual LoRA capability: **limited**, T2VA influence GPU-verified. FL2VA/Ref2VA routes структурно поддерживают modifier, но их комбинации не GPU-verified.

Artistic Style Transfer via Picture Reference остаётся **failed**. Ранее S0/S1(stained-glass)/S2 не подтвердили перенос artistic style через Picture Reference; повторять suite не стали. [Предыдущий Ref2VA report](h3-ref2va-capability-test-2026-09-27.md).

Различие механизмов: Picture Reference — appearance/object/identity conditioning; эта LoRA — global rendering bias с побочным изменением appearance. LoRA influence не исправляет style-transfer verdict.

Минимальный reusable registry имеет id/title/category/source/base/path/SHA/trigger/default+motion strength/task families/status/license/notes. UI строится по registry category=visual, не содержит отдельного Cinematic screen; для второго allow-listed modifier нужны artifact metadata и backend validation, не новый special-case UI. Marketplace/model browser не создавались.

Стоит развивать маленький Visual LoRA layer для **контролируемых visual variants**, но пока не как identity-critical production finalizer. Для routing/Decision Layer данных недостаточно.

## SnarkRoute implementation и checks

Scoped changes этой работы (исходный worktree уже содержал другие изменения):

- H3 adapter/hosted client: Turbo schema/profile/endpoint mapping, pricing cutoff, unsupported-field rejection; local visual strength/trigger serialization и hosted rejection.
- Server H3 runtime/queue/routes: Turbo hosted selection, visual modifier persistence/provenance/validation; explicit null clearing при editing, fixed download allow-list.
- Studio H3 panel: Turbo selection/capability restrictions, registry-driven Visual Modifier controls/default+motion presets, opt-in trigger, download/error status и взаимное исключение FaceSwap.
- Worker config/models/backend/manager/manifest: pinned safetensors download+hash, nested remote path, per-job visual LoRA apply, distinct limited capability, metadata provenance; detached MATLOW launcher nohup.
- Evaluation scripts и offline aggregate report/tests; scoped MP4 ignore rules.

Focused automated checks, **без платных вызовов**:

| Scope | Passed |
|---|---:|
| H3 adapter tests | 18 |
| Server H3 runtime / queue / existing hosted regeneration | 9 / 12 / 2 |
| Studio H3QueuePanel, включая registry UI tests | 28 |
| Model catalog H3 pricing | 1 |
| Worker identity/visual, MATLOW, API, manifest | 33 |
| Offline report lineage/blocked output/contamination tests | 2 |

Итого **105 focused tests passed**. Покрытие: Turbo profile/endpoints/T2V/I2V/FL1/unsupported fields/pricing/errors/insufficient credits/ingestion/provenance; Visual registry/pinned artifact/hash/serialization/trigger/state/reset guards/capability. Hosted regeneration tests не считаются Max→local2K GPU acceptance. Offline blocked-pipeline tests проверяют lineage и отсутствие выдуманного result.

Builds: `@snarkroute/h3`, `@snarkroute/model-catalog`, `@snarkroute/server`, `@snarkroute/studio` passed. Studio сообщает существующий large-chunk warning, не build error. Launcher bash syntax проверен. `graphify update .` обновил AST graph без LLM/API; SQL parser warning и устаревшие skill-copy/community labels не исправлялись как unrelated. Граф помог ограничить поиск H3 областью; полный architectural audit не выполнялся.

## Что посмотреть глазами

1. Max/Turbo I1 и FL1: первый и последний кадры, последовательность поворота и push-in. Прослушать room tone/rustle/breath/shutter — эта часть пока без perceptual verdict.
2. Base/C1/C2M: лицо, причёска, фон и свет. 0.5/0.7 — artistic variation, не обещание сохранить персонажа.
3. C1/C2: сравнить no DY и DY; обязательный trigger не доказан.
4. C0/C0R: identical control; 2K панели результата нет, поскольку локальный backend отсутствует.
