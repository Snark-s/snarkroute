# Vimeo: продолжение нормализации и сравнения — 2026-10-04

**Vimeo comparison SUCCEEDED; весь bake-off остаётся PARTIAL.** Использован сохранённый успешный inference Vimeo. Новых neural jobs, model loads, worker starts и downloads: **0**. SPAN/GameUp остаются ранее BLOCKED; новые submissions не выполнялись. Победитель не выбран, motion/identity review остаётся для человека.

## История и разрешение

После освобождения памяти GPU precheck прошёл: 14126 MiB free при пороге 8192 MiB; доступная RAM около 15.5 GiB при пороге 4 GiB. Первая continuation `comparison-2026-10-03` остановлена CPU guard: sampled process peak 192.36% (100%=одно ядро), >180% на sustained interval 10 с. Общая sampled CPU peak 21.59%. Прерванный MP4 невалиден; сохранён как `comparison-2026-10-03/interrupted-vimeo.mp4` с исходным SHA-256, audit и failed verification.

Пользователь отдельно разрешил: **«guard 200%, максимум два CPU»**. Следующая попытка `comparison-2026-10-04` выполнена с process CPU guard 200%, тем же sustained interval 10 с, total CPU guard 85%, RAM guard 4096 MiB, precheck VRAM 8192 MiB/runtime VRAM 512 MiB. Affinity mask **3**, FFmpeg decode/filter/encode threads **2**; OMP/MKL/OpenBLAS/NumExpr pools **2**. Лимит по умолчанию остаётся 180%; повышение применяется только явно через `LOCAL_VIDEO_BENCHMARK_PROCESS_CPU_LIMIT=200` для review, не превышает 200% и не меняет inference policy.

Каждая попытка имеет новый persistent marker; предыдущие markers не удалены. Один global active.lock, никаких concurrent media jobs. Existing baseline проверен и повторно использован без render. Guard теперь проверяется во время ожидания FFmpeg с интервалом до 0.25 с, а не только после завершения команды. Новых попыток после failure автоматически не было.

## Результат

- Vimeo normalized: **2560×1440**, content2520×1440 + pad20px left/right, SAR1, 124 frames, 24fps, H.264/YUV420P, libx264 medium CRF18/GOP48. Все color tags BT.709/limited (`tv`). Normalize + metadata/audio verification: **22.842 с**. SHA-256: `41e502b62940eb51b210a3050ce37672f8b667bc6d95228964edc7a15a0d6c44`.
- SDR BT.709 limited остаётся **test assumption** для исходника без тегов. Explicit limited709→fullRGB decode и fullRGB→limited709 encode сохранены, gamma/contrast/saturation не менялись. Native Vimeo оставлен неизменным с прежними неполными transfer/primaries tags; downstream normalized output имеет полный профиль.
- Original AAC stream copy, **163 packets**; ordered packet size/hash sequence совпадает с исходником: `05779dbc6e656cb2b6a246dc13e4fef030d9b37dbf4a74936b189036ed098802`. Без audio re-encode и без `-shortest`.
- Review содержит synchronized full-size players, normal speed 1× по умолчанию, slow playback, frame slider; contact sheet frames **0/31/62/92/123**, native pixel crops восьми областей и полосы всех chunk/context boundaries. Crops отображаются 1:1 без resampling; координаты фиксированы, не landmark-tracked.
- Отдельный full-speed paired MP4: **2560×720**, слева Original, справа Vimeo; каждый panel1280×720. Это обзор движения; для деталей использовать full-size 2560×1440 версии и native crops. 124frames/24fps, тот же encode/color profile, AAC identity подтверждена. Render **18.477 с**, файл **3145117 bytes**.
- Build review wall **84.618 с**; отдельный paired render записан отдельно. Эти времена не являются inference performance. Все owned процессы завершены, порт8092 закрыт, active.lock отсутствует. Старый Vimeo raw FAILED/shutdown UNKNOWN сохранён, ретроспективно CLEAN не объявлен.

| Sampled metric | Review/normalization | Paired render |
|---|---:|---:|
| Owned CPU peak, 100%=one core | 189.48% | 190.84% |
| Total system CPU peak | 38.63% | 91.03% |
| Owned RSS peak | 834.62 MiB | 656.36 MiB |
| Available system RAM minimum | 15.03 GiB | 14.40 GiB |
| System GPU used peak / free minimum | 2082 / 14094 MiB | 2079 / 14097 MiB |
| Samples | 37 | 8 |

Это samples примерно раз в 2 с, не exhaustive instantaneous peaks. Total system CPU включает все процессы; AST update Graphify выполнялся одновременно с paired render и не входит в owned FFmpeg Job. Peak91.03% выше total guard85%, но sustained interval10с не достигнут, поэтому stop condition не сработал. Affinity/CPU cap media job оставался два logical CPUs; system-level CPU не ограничивается этим Job.

## Проверка и ограничения

**43 focused tests passed**: continuation history/overwrite guards, CPU override validation, benchmark policy/commands/locks/shutdown, pipeline/temporal/registry. Без ML/CUDA в тестах. `graphify update .` завершён AST-only; зависимости не устанавливались. Local HTML media/href paths проверены; contact sheet layout проверен визуально. Browser automation блокирует протокол `file://`; обход не выполнялся. Непрерывный normal-speed/slow просмотр не подтверждён, identity/temporal/artifact quality не оценена и sharpness winner не выбран.

Vimeo/SPAN: **CC-BY-SA-4.0**. GameUp: **CC-BY-NC-SA-4.0**, noncommercial restriction остаётся видимой.

## Артефакты

[Review HTML](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-2026-10-04/index.html) · [Full-speed video](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-2026-10-04/baseline-vimeo-full-speed.mp4) · [Vimeo normalized](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/normalized/vimeo.mp4) · [Contact sheet](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-2026-10-04/contact-sheet-normalized.jpg) · [Review verification](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-2026-10-04/verification.json) · [Resource summary](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison-2026-10-04/continuation-summary.json) · [Current run.json](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/run.json).
