# SnarkRoute: Local Video Upscale bake-off — 2026-10-01

## Production decision — 2026-10-04

**COMPLETED FOR CURRENT PRODUCTION DECISION.** VimeoScale `openmodeldb/vimeoscale-unet-x2` is selected as the default conservative local Video Upscale for the tested H3 Max / CUDA / 2× generated-video class. SPAN was tested but not selected: normalized portrait crops did not establish convincing useful detail gain over Vimeo. GameUp remains unverified/experimental/noncommercial and is not required for this decision. This is not a universal model ranking. No additional neural benchmarks are required.

[Production profile, UI and operational behavior](../video-upscale-production.md). Existing research artifacts and historical statuses below are retained as the audit trail.

## PUREPHOTO SPAN CONTROLLED RUN — 2026-10-04

**SPAN execution + comparison SUCCEEDED**, один CUDA job `vup_9dd1c060-3409-48e1-97c2-ff1c87755839`, no retry/warmup/download/other models. Pinned9016490bytes, SHA`c689eec59771ed3eaffc10eea933c44fdb9131f83251c51c5bab4cae7c4d3bf2`. Native5376×3072/124frames/24fps/SAR1; normalized2560×1440; BT.709 limited tags и AAC163packet identity validated. Shutdown DELAYED_CLEAN, owned processes0, port8092free. Vimeo/source/baseline сохраняют прежние SHA.

Processing299.485с, forward103.459с; sampled torch allocated/reserved251.57/290.00MiB, system GPU peak2617MiB, owned RSS peak4.407GiB, owned CPU peak187.95% (one core=100%). Native inference guard180% не расширен; postprocess guard200% с двумя logical CPUs. Finished triple review содержит три строки без placeholders, девять native crop regions, matching normalized crops, full-speed video и actual tile-blend overlays.

Preliminary static observation: SPAN выглядит более сглаженным, заметного useful microdetail gain относительно Vimeo на проверенных crops не вижу. Temporal shimmer/flicker требует human1×→0.5×→0.25× просмотра; winner не выбран. GameUp не запускался. [Полный текущий отчёт и артефакты](Y:/Процесс/SnarkRoute/docs/research/purephoto-span-controlled-run-2026-10-04.md).

Ниже сохранены предыдущие стадии и исторический snapshot 2026-10-01.

**Обновление 2026-10-04:** нормализация и comparison Vimeo завершены после отдельного разрешения guard200%/два CPU; inference не повторялся. [Текущий отчёт](Y:/Процесс/SnarkRoute/docs/research/vimeo-comparison-continuation-2026-10-04.md). Ниже сохранён исторический snapshot 2026-10-01; SPAN/GameUp по-прежнему без новых запусков.

Статус: **STOPPED_RESOURCE_BLOCKED, результат неполный**. Harness исправлен и проверен без нейронки. Vimeo повторно не запускался. SPAN и GameUp заблокированы до запуска worker/model. Подготовка полного сравнения остановлена RAM guard. Победитель не выбран.

## Infrastructure и решение Vimeo rerun

- Старый Vimeo CUDA inference **SUCCEEDED**: job `vup_ed035e79-9c5a-46f4-976e-65e4529111c8`, 124 кадра. Старый overall FAILED относится к harness verification.
- Причина старого shutdown failure **UNKNOWN**: не сохранены return code и снимок активных процессов. Старое условие сразу после `worker.wait()` могло поймать отложенный выход child/conhost, но это гипотеза. Ретроспективно CLEAN/UNCLEAN доказать нельзя. Старый final cleanup подтвердил zero owned processes и VRAM 1857 → 1802 MiB.
- Новый shutdown: authenticated request → immediate snapshot → bounded grace до 15 с → final snapshot/classification. CLEAN/DELAYED_CLEAN допустимы; UNCLEAN требует force termination и остаётся failure; UNKNOWN останавливает дальнейший bake-off. Сохраняются worker PID, owned child PIDs, start/exit timestamps/status, return code, shutdown timestamp, stdout/stderr tail, listener state и final cleanup.
- Synthetic worker: **DELAYED_CLEAN**, return code **0**, выход за **0.303 с**, final owned processes **0**, порт 8092 закрыт. В immediate snapshot видны venv launcher, реальный Python child и conhost. Это подтверждает необходимость grace, но не устанавливает причину старого сбоя.
- Process leak detection теперь использует Windows Job Object accounting и сохраняемые process handles/identities. PID enumeration sampled; нельзя обещать обнаружение каждого короткоживущего child между samples. Active Job count остаётся обязательным final gate. UNKNOWN/UNCLEAN не подавляются; failed final cleanup сохраняет active.lock.
- CPU: FFmpeg decode/encode/filter pools ≤2; OMP/MKL ≤2; torch intra=2/inter=1; ORT intra=2/inter=1, CPU fallback disabled и CUDA Node profile обязателен. Job affinity mask 3 и harness affinity ограничивают те же два logical CPUs. Внешние процессы не изменялись.
- Цвет: source без тегов трактуется как **SDR BT.709 limited** — TEST ASSUMPTION, не recovered fact. Decode остался `scale=in_color_matrix=bt709:in_range=tv:out_range=full,format=rgb24`. Encode RGB full → BT.709 limited YUV420P; после conversion добавлен `setparams` для frame tags, output options сохранены. FFprobe подтверждает `color_primaries=bt709`, `color_transfer=bt709`, `color_space=bt709`, `color_range=tv`.
- Synthetic: 168×96 / 24 fps / 12 кадров, identity RGB, AAC stereo 32 kHz. Geometry/count/fps сохранены; original/output AAC packet sequence identity доказана. Старый filter воспроизвёл отсутствующие transfer/primaries; fixed filter дал полный профиль. SHA decoded YUV old/fixed совпал: `852e10a8208d57f6889cd854fa8ef79b37ac72f69b943d37bd0e834d0262205d`.
- **Actual model input pixels не менялись. CASE A: Vimeo rerun НЕ требуется.** Decoder command/filter остался идентичным; shared MAX-I1 RGB sequence SHA-256 `bd7634c38d334199fef87f1e6960d92fa1ca7e92ed249d1b8dc224856840e1eb`. Исходный файл SHA проверен: `ed5dc65e35c27707655cf025b2e9a6cf36fdabdb8ebe9708adf7875db467e8f9`. Native Vimeo SHA `a5cae1aa824ddd3ddf69fd3d1eb626f1cc874742597c808043edf3e7b9e55b60` совпадает с предыдущей проверкой; native.mp4 не переписан.
- Обоснование `setparams`: [FFmpeg filter documentation](https://www.ffmpeg.org/ffmpeg-filters.html#setparams). Доказательство здесь — реальные synthetic/ffprobe результаты, а не command line.
- Focused verification: **33 passed** (`test_video_benchmark`, `test_video_pipeline`, `test_video_temporal`, `test_video_registry`). Новые behavioral tests сначала были red. Нейронных jobs/downloads/retries в этой фазе: **0/0/0**.

## Кандидаты и performance

| Поле | Vimeo (старый успешный inference) | SPAN | GameUp |
|---|---|---|---|
| Результат | native reused; comparison incomplete | BLOCKED | BLOCKED |
| Model | openmodeldb/vimeoscale-unet-x2 | framewise/4x-purephoto-span | openmodeldb/gameup-v2-tscunet-small-x2 |
| Настройки | scale2, context3, chunk3, overlap1 | scale4, tile256/32, chunk1 | scale2, context5, chunk4, overlap2 |
| Native | 2688×1536, 124 frames, 24 fps | ожидается 5376×3072; отсутствует | ожидается 2688×1536; отсутствует |
| Startup | 1.623 с | не запускался | не запускался |
| Cold load | 12.251 с | нет | нет |
| Processing wall | 227.959 с | нет | нет |
| Старый harness wall / новый precheck wall | 234.684 с | 2.117 с (НЕ inference) | 2.115 с (НЕ inference) |
| Inference wrapper / forward | 207.077 / 194.325 с | нет | нет |
| Torch allocated / reserved peak | 5217.03 / 9616.00 MiB | нет | нет |
| Sampled system GPU used peak / free min | 11643 / 4533 MiB | precheck used11716/free4460 MiB | precheck used11716/free4460 MiB |
| Sampled owned CPU peak (one core=100%) | 177.65% | нет inference samples | нет inference samples |
| Sampled total CPU peak | 69.26% | нет | нет |
| Sampled owned RSS peak / available RAM min | 2.195 / 12.706 GiB | нет | нет |
| CUDA / CPU fallback | CUDA succeeded | не запускалась | не запускалась; ORT execution не проверен на этой машине в этой фазе |
| Validation | geometry/frames/fps/AAC valid; original native tags incomplete | NOT_RUN | NOT_RUN |
| License | CC-BY-SA-4.0 | CC-BY-SA-4.0 | **CC-BY-NC-SA-4.0: noncommercial** |

Vimeo phases: decode pipe wait 1.220 с; preprocessing 3.965 с; postprocessing 8.325 с; encode pipe wait 1.512 с; encoder finalize wait 5.497 с; audio mux 0.080 с. Piped decode/encode overlap inference; waits не являются codec compute time. CUDA forward синхронизирован. GPU/system/CPU/RSS samples примерно раз в 2 с, это sampled observations, не exhaustive instantaneous peaks. Model memory нельзя приписывать всей system VRAM. SPAN/GameUp performance сравнить невозможно.

GPU: NVIDIA GeForce RTX 3080 Laptop GPU, total 16384 MiB. Оба model precheck дали free **4460 MiB < 8192 MiB**. Зафиксированы persistent blocked attempts. Внешний `llama-server.exe` виден в compute process list; WDDM per-process memory N/A, поэтому конкретный объём ему не приписывается. Внешние процессы не завершались. CPU fallback, tile changes, повторные submissions, warmup и settings sweep не выполнялись.

## Comparison и human review

- Подготовка comparison остановлена: **Available RAM below safety threshold**, sampled available **3.766 GiB < 4 GiB**. Это stop condition; новых media jobs после остановки не запускалось. Только лёгкий ffprobe audit уже созданного baseline и запись отчёта.
- Original baseline создан и проверен: **VALIDATED_EXISTING_BASELINE**. Canvas 2560×1440, content2520×1440, pad20px left/right, SAR1, 124 frames/24fps/H.264/YUV420P; libx264 medium CRF18/GOP48, полный BT.709 profile. Original AAC stereo 32 kHz скопирован; **163 packets**, packet-size/hash identity совпадает, `-shortest` не используется.
- Vimeo native содержит original AAC identity. Native намеренно сохранён с исходными неполными transfer/primaries tags; matching downstream normalization для Vimeo не создан. SPAN/GameUp native и normalized outputs отсутствуют.
- Полная четырёхстрочная contact sheet, native crops, boundary strips, matched temporal comparison и supporting temporal analysis **не созданы**. Ни placeholder, ни source-frame-62 не выданы за finished comparison.
- Identity observations: **NOT_EVALUATED**. Temporal observations: **NOT_EVALUATED**. Detail/artifact observations: **NOT_EVALUATED**. Нет matched comparison; лицо, волосы, украшения и temporal stability оценивать сравнительно пока нельзя. Автоматического aggregate score и winner нет; high-resolution ground truth отсутствует.
- В странице доступных артефактов можно отдельно посмотреть старый Vimeo native на **normal speed first**, затем 0.5×/0.25×, и проверенный Original baseline. Это preliminary просмотр, не finished fair comparison. Смотреть eye shape/brows/nose/lips/jaw/hairline/ears/earrings/pendant; затем flicker/crawling/shimmer/edge wobble/texture boiling, волосы/украшения/background; затем useful detail против halos/ringing/invented lashes/hair/pores/plastic skin/smearing. Sharpness ≠ quality; изменение человека остаётся отрицательным критерием.
- Сохранён Vimeo chunk/context metadata (42 chunks; transitions every 3 frames, края 0/123). Review strips не построены. Для SPAN chunks не имеют temporal-model meaning; GameUp boundaries отсутствуют.

## Артефакты и завершение

- [Machine-readable run.json](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/run.json)
- [Vimeo native](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/vimeo/native.mp4) — существующий output job `vup_ed035e79-9c5a-46f4-976e-65e4529111c8`.
- [Original normalized baseline](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/normalized/original.mp4) и [verification](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/normalized/original-verification.json).
- [Страница доступных артефактов / normal-speed review](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison/index.html).
- [Synthetic proof](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/synthetic/verification.json).
- [Vimeo chunk boundaries](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison/vimeo-chunk-boundaries.json).
- Native SPAN/GameUp: отсутствуют. Normalized Vimeo/SPAN/GameUp: отсутствуют. Contact sheet/crops/strips: отсутствуют.
- Final: owned processes synthetic/review/audit **0/0/0**; порт 8092 **closed**; active.lock **absent**. Внешняя GPU нагрузка остаётся отдельной; benchmark model context в этой фазе не создан.
- Для продолжения нужны доступные GPU/RAM ресурсы и новое явное указание на следующую фазу. Persistent attempts сохранены; автоматического повторения blocked candidates нет. H3 и остальные subsystem code не изменялись.

Изменения этой фазы: `app/video_benchmark.py` (output frame tags), `app/benchmark_resources.py` (process identities), `scripts/run_video_bakeoff.py` (shutdown/gates/artifacts), focused benchmark tests; добавлены synthetic verifier и bounded-resource review builder. Дополнительные reads ограничены worker runtime/pipeline/service для проверки no-fallback и telemetry; comparison helper прочитан для оценки повторного использования и не запускался. Обязательный `graphify update .` выполнен AST-only без LLM/API. Сообщён пропуск SQL AST из-за отсутствующего parser; новые зависимости не устанавливались.

## Продолжение по новому указанию пользователя — 2026-10-01 15:07:14 (Europe/Moscow)

Новый полный precheck: **BLOCKED_RESOURCE_PRECHECK**. Свободная VRAM **4627 MiB < 8192 MiB**; доступная system RAM **3.698 GiB < 4.000 GiB**. Thresholds и CPU/resource guards сохранены.

Источник MAX-I1 и все три установленные model SHA-256 совпадают с сохранённым inventory. После исключения самого процесса precheck и его ancestors: stale upscale workers **0**; порт 8092 **free**; active.lock **absent**. Никакие внешние процессы не завершались.

Vimeo inference не повторялся. Synthetic verification не повторялся: pixel-path filters совпадают с сохранённым successful proof, code/config остаются состоянием предыдущей фазы. Предыдущий synthetic не сохранял полный SHA manifest; это ограничение не скрыто. Текущие whole-file SHA-256 впервые явно сохранены в precheck для следующей проверки. Code/config files предшествуют сохранённому run state; репозиторий в этом продолжении не изменялся.

SPAN/GameUp не запускались: ни worker, ни model load, ни job submission. Persistent attempts/history не сбрасывались. Новые contact sheet/crops/normalized/temporal artifacts не создавались. Существующие native Vimeo, Original baseline и preliminary review page сохранены. Оценки identity/detail/temporal остаются NOT_EVALUATED; автоматического winner нет.

[Новый precheck](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/history/continuation-precheck-final-20261001T120714.json) · [Снимок предыдущего run.json](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/history/run-before-continuation-20261001T120714.json) · [Обновлённый run.json](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/run.json).
