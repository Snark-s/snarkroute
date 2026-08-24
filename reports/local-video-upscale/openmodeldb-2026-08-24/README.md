# OpenModelDB temporal video upscale comparison — 2026-08-24

Этот пакет фиксирует воспроизводимое сравнение настоящих temporal video SR-моделей с двумя
framewise baseline. Итогового quality score и автоматического победителя здесь нет: числовые
temporal-метрики описывают output, но не заменяют просмотр MP4 и sheets.

## Добавленные temporal-модели

| Registry ID | Architecture/runtime | Context | Scale | Checkpoint license | Intended material |
|---|---|---:|---:|---|---|
| `openmodeldb/gameup-v2-tscunet-small-x2` | TSCUNet / ONNX Runtime CUDA | 5 RGB frames, center-frame | 2× | CC-BY-NC-SA-4.0; NC, SA | compressed game/CGI video |
| `openmodeldb/vimeoscale-unet-x2` | SOFVSR optical flow + RRDB / PyTorch CUDA | 3 RGB frames, center-frame | 2× | CC-BY-SA-4.0; SA | natural, CGI, motion graphics |
| `openmodeldb/redsval-7f-rrdb-lite-x4` | SOFVSR optical flow + RRDB / PyTorch CUDA | 7 RGB frames, center-frame | 4× | CC-BY-NC-SA-4.0; NC, SA | clean/general video |
| `openmodeldb/video-tssm-x3` | SOFVSR optical flow + luminance SRNet / PyTorch CUDA | 3 frames, center-frame | 3× | CC-BY-NC-SA-4.0; NC, SA | animation/cartoon |

`commercial_use` в live catalog равен `false` у трёх NC-checkpoint и `true` у VimeoScale.
Это фактическая маркировка лицензий из карточек, не юридическая интерпретация.

Registry содержит точные download URL, byte size и SHA-256. Чекпойнты загружались только для
этих четырёх CUDA-tested моделей через существующий disk-space gate, resumable `.part`, checksum
verification и atomic publish.

## Что исследовано и не добавлено

- Полные GameUp/GameUpV2 TSCUNet действительно temporal, но это более тяжёлые варианты той же
  архитектуры и того же сценария; выбран один Small checkpoint, чтобы не набивать registry дублями.
- SOFVSR_REDS_F3, 4x VimeoScale и SBS11 — temporal, но старее либо дублируют уже выбранную
  SOFVSR-семью; часть download hosting менее пригодна для воспроизводимой установки.
- `video_G` и `VESRGAN_G` выглядят temporal, но checkpoint license в OpenModelDB не указан — не добавлены.
- CAIN, CAIN-YUV и RIFE — frame interpolation/FPS increase, а не spatial video SR — исключены.
- Модели с тегом `Video Frame` на SPAN, RealPLKSR, DAT2, HAT, GRL, SwinIR, RGT и Real-ESRGAN
  остаются framewise и не выдаются за temporal. Две из них использованы только как baseline.

## Полный pipeline smoke

Каждая добавленная модель прошла реальный путь:

`Model Gateway → local_video_upscale → authenticated worker → CUDA → FFmpeg MP4 result asset`

Для всех четырёх моделей подтверждены decode, CUDA execution, encode, dimensions, FPS, frame count,
duration, AAC preservation и `provider cost = 0`. BoojumRoute получает их из live endpoint
`/api/models/for-node/local_video_upscale`; node label — **Local Video Upscale / Restoration**.

## Performance fixture

GPU: NVIDIA GeForce RTX 3080 Laptop GPU, driver 610.88, 16 GiB. По одному 6-frame/6 FPS cold run на
native scale; x2 использует 640×360 → 1280×720, x4 — 320×180 → 1280×720, x3 — 426×240 → 1278×720.

| Model | Total s | Load s | Inference s | Effective FPS | Peak VRAM MiB |
|---|---:|---:|---:|---:|---:|
| GameUpV2 TSCUNet Small x2 | 11.21 | 5.49 | 4.00 | 0.54 | unavailable: ORT/WDDM |
| VimeoScale Unet x2 | 20.74 | 8.89 | 11.24 | 0.29 | 1175.4 |
| REDSVAL 7f RRDB Lite x4 | 14.36 | 1.26 | 12.56 | 0.42 | 1732.1 |
| Video TSSM x3 | 2.34 | 0.22 | 1.57 | 2.56 | 616.7 |
| Framewise PurePhoto SPAN x4 | 2.94 | 0.60 | 1.92 | 2.04 | 93.9 |
| Framewise HFA2k LUDVAE GRL Small x4 | 9.52 | 2.22 | 6.75 | 0.63 | 188.7 |

У всех строк: 6 input frames = 6 output frames, 6 FPS, duration 1.0 s, AAC preserved, zero duplicate
adjacent frames и provider cost 0. PyTorch VRAM — `torch.cuda.max_memory_allocated`; ONNX Runtime под
Windows/WDDM не даёт сопоставимого per-session peak, поэтому вместо ложной цифры сохранено `null`.

## Temporal sanity и визуальная проверка

`metrics.csv` содержит для каждого из 24 общих прогонов:

- frame-to-frame mean и p95 difference;
- variation в статичной верхней левой области;
- adjacent duplicate count;
- chunk-boundary difference, когда короткий fixture действительно пересекает boundary;
- frame/FPS/duration/audio integrity;
- load, inference, total time, effective FPS и VRAM method.

Значения не агрегируются в рейтинг. Разный native scale и разная степень восстановления меняют
саму амплитуду pixel differences, поэтому меньшая цифра не означает автоматически лучшее видео.

## Найденный pipeline bug

На первом realistic-size прогоне worker записывал 6 RGB frames, но FFmpeg option `-shortest` мог
оставить в muxed MP4 только 3–5 frames в зависимости от скорости обработки и audio timestamps.
Опция удалена: теперь raw video stream завершается фактическим EOF, а исходная audio track копируется
без обрезания video. Добавлен regression test; повторный прогон дал 6/6 для всех моделей.

## Файлы

- `fixtures/` — четыре общих synthetic fixtures с AAC и три native-scale performance fixtures.
- `<fixture>/<model>/output.mp4` — 24 одинаковых сравниваемых output.
- `performance/<model>/output.mp4` — 6 realistic-size output.
- `metrics.csv`, `performance-metrics.csv` — плоские таблицы.
- `report.json`, `performance-report.json` — raw catalog metadata, gateway/worker telemetry и metrics.
- `*-contact-sheet.png` — одинаковые frames по всем моделям.
- `*-crop-sheet.png` — 100% crop-oriented sheets.
- `*-temporal-strip.png` — последовательные frames одного crop по каждой модели.

## Ручной отбор

Для следующего визуального этапа разумно оставить все четыре temporal checkpoint: они покрывают две
реально разные runtime/architecture families, три native scale и разные training targets. Сначала
смотреть соответствующий материалу output (GameUp — game/compression, VimeoScale — natural/CGI,
REDSVAL — clean x4, TSSM — animation), затем сравнивать temporal strip с двумя framewise baseline.
Окончательного победителя этот прогон намеренно не назначает.
