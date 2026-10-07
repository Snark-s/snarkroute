# H3 Max integration and controlled capability tests

Дата фиксации: 2026-09-28. Этот отчёт отделяет факты H3 Max от MiniMax H3 Base, H3 Max Turbo, H3 Max Director и сторонних/community-моделей. CameraPath не менялся и не входил в тестовый набор.

## 1. Provenance H3 Max

H3 Max — размещённый у fal вариант семейства MiniMax H3, который fal описывает как собственную post-trained/co-optimized версию открытого H3 Base. Открытый upstream Base опубликован MiniMax как `MiniMaxAI/MiniMax-H3`; отдельные публичные weights H3 Max в проверенных первичных источниках MiniMax/Hugging Face не найдены. Поэтому в SnarkRoute provenance хранится как `provider=fal`, `model=fal/minimax-h3-max`, `upstream=MiniMaxAI/MiniMax-H3`, а не как новая локальная ревизия Base.

Источники: [fal H3 Max T2V](https://fal.ai/models/minimax/h3-max/text-to-video/api), [MiniMax H3 open source announcement](https://www.minimax.io/news/minimax-h3-open-source), [официальная карточка H3 Base](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/README.md).

## 2. Provider и model IDs

- Provider/auth: fal, серверный `FAL_KEY`.
- Профиль SnarkRoute: `fal/minimax-h3-max`.
- T2V endpoint: `minimax/h3-max/text-to-video`.
- I2V/First+Last endpoint: `minimax/h3-max/image-to-video`.
- Semantic references endpoint: `minimax/h3-max/reference-to-video`.

## 3. Hosted или local

H3 Max интегрирован только как hosted provider model: Studio → существующая H3 Queue → server session runtime → fal queue API → обычный локальный result asset. Он не добавлен в local SGLang/H3 worker. H3 Base остаётся локальной моделью; provider-only Max-сессия не требует и не арендует GPU-worker.

## 4. Реальная API schema

Общие документированные поля, которые использует adapter: `prompt`, целочисленный `duration` 5–15, `resolution` (`480P`, `768P`, `1080P`), `seed`, `enable_safety_checker`, `prompt_expansion_mode` (`disabled`, `balanced`, `quality`). T2V также принимает `aspect_ratio` и опциональный `target_audio_url`. I2V принимает `image_url` и/или `end_image_url`, а также `target_audio_url`. Reference-to-video принимает `reference_image_urls`, `reference_video_urls`, `reference_audio_urls` и `aspect_ratio`; в prompt ссылки адресуются как Image/Video/Audio N.

Adapter не пересылает Base-only поля, запрещает несколько variants в одном fal request, локальную FaceSwap LoRA и смешивание keyframe/target-audio semantics с semantic-reference endpoint. Локальные assets переводятся в data URI; также разрешены HTTPS/data URI. Submit выполняется асинхронно, затем status/result polling и скачивание результата.

Первичные схемы: [T2V](https://fal.ai/models/minimax/h3-max/text-to-video/api), [I2V](https://fal.ai/models/minimax/h3-max/image-to-video/api), [Reference-to-video](https://fal.ai/models/minimax/h3-max/reference-to-video/api).

## 5. Поддерживаемые inputs

- Text prompt: да, verified.
- First frame: да, verified.
- Last frame и end-only: документированы; First+Last реально проверен.
- Semantic image references: да; два изображения реально проверены.
- Semantic video reference: да, реально проверен.
- Semantic audio references: документированы, но отдельный реальный audit не завершён.
- Target audio replacement: документирован в T2V/I2V, не проверен отдельным render.
- Reference endpoint: максимум 12 файлов суммарно. Video/audio reference должны быть 2–15 секунд, а объединённая длительность этих modalities — не более 15 секунд по текущей документации.

I2V first frame не приравнивается к semantic image reference: это разные endpoints и conditioning semantics.

## 6. Поддерживаемые outputs

Provider возвращает один video asset на request, optional `seed`, `expanded_prompt` и timings. Все пять успешных controlled renders были MP4/H.264, 24 fps, 1344×768 при запросе `768P`, длительностью 5.184 с, с AAC stereo 32 kHz. SnarkRoute скачивает результат, сохраняет его в обычный results pipeline и добавляет thumbnail/preview, request/result metadata и provenance.

## 7. Resolution и duration

API предлагает `480P`, `768P`, `1080P`; 1080P описывается provider как latent refinement от 768P, а не как отдельная локальная Base 2K regeneration. Длительность H3 Max в интеграции ограничена документированным безопасным диапазоном 5–15 секунд. Native 2K/Regenerate для H3 Max API не подтверждены и не экспонируются.

## 8. Audio behavior

У всех пяти успешных Max-роликов реально присутствует AAC stereo 32 kHz; аналогично у Base control. В сложном prompt требовались room tone, rustle, breath и shutter cue: звуковая дорожка есть, а финальный transient согласуется с shutter cue, но автоматическая проверка не доказывает точную семантику каждого звука. Документированного `disable_audio` поля не найдено; `target_audio_url` заменяет/задаёт аудиотрек, а не отключает его.

Отдельный dialogue/lip-sync case `MAX-A1` был отклонён до принятия job с нормализованной ошибкой `insufficient_credits` (fal HTTP 403, exhausted balance). Поэтому dialogue, lip-sync и отдельная семантика audio reference остаются unverified.

## 9. MAX-T0 — Text-to-Video

Request `01a0e48b-1078-7750-943b-23107ccc1567` успешно выполнен через `minimax/h3-max/text-to-video`. Результат следует общей постановке: студийный женский портрет, поворот в камеру, push-in, стабильный свет и звук; без identity reference модель создала другую внешность, что ожидаемо. Provider inference: 2.677 с. Сохранённый end-to-end recovery/download замер 3.412 с нельзя считать строгим полным latency из-за обнаруженной тогда ошибки первоначального polling path.

Артефакты: [video](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-T0/output.mp4), [request](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-T0/request.json), [metadata](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-T0/metadata.json).

## 10. MAX-I1 — Image-to-Video

Request `01a0e48c-d255-7df2-a10e-9fcbb4e5ac7d` успешно выполнен с тем же production prompt и first frame. Subject и исходная композиция сохраняются, профиль переходит к фронтальному взгляду, push-in остаётся coherent. Accepted 0.331 с, generation/poll 5.073 с, download 3.740 с, итого 9.144 с; provider inference 2.990 с.

Артефакты: [video](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-I1/output.mp4), [review strip](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-I1/review-strip.jpg), [metadata](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-I1/metadata.json).

## 11. MAX-FL1 — First + Last

Request `01a0e48c-f938-7f32-b561-cc8ba151c7e8` успешно принял `image_url` + `end_image_url`. Переход coherent, без абсурдной склейки, но последняя картинка является направляющим condition, а не pixel lock. SSIM финального кадра с target = 0.7357; для I1 без last frame = 0.7452. Это не доказывает отсутствие эффекта: shot требовал push-in, конфликтующий с framing target. Итоговый статус capability: verified, limited по точности endpoint frame.

Latency: accepted 0.710 с, generation 5.766 с, download 2.435 с, всего 8.911 с. Артефакты: [video](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-FL1/output.mp4), [generated vs target](../../apps/server/data/h3-max-eval/2026-09-27-controlled/compare-fl1-last.jpg).

## 12. MAX-V1 — Video Reference

Отдельный официальный endpoint существует и реально работает. Request `01a0e48d-1dd5-7611-9b31-b8eaaed86f67` использовал тот же Base reference video. Motion/timing/camera reference заметно контролируют результат, identity остаётся стабильной; при этом финал не сел строго square-to-camera, то есть reference motion конкурирует с текстовым ending state. Accepted 0.783 с, generation 13.611 с, download 4.184 с, всего 18.578 с; provider inference 7.650 с.

Артефакты: [Max video](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-V1/output.mp4), [Base vs Max contact sheet](../../apps/server/data/h3-max-eval/2026-09-27-controlled/compare-base-max-v1.jpg), [metadata](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-V1/metadata.json).

## 13. Base vs Max comparison

Controlled I1 использовал одинаковые first frame, prompt, seed 5242017, duration 5 с и aspect ratio 16:9. Base preview был 960×544/4 steps, Max — 1344×768, поэтому сравнение качества не является чистым одинаковым-resolution benchmark.

| Критерий | Base control | H3 Max I1 |
| --- | --- | --- |
| Prompt/action | Профиль→фронт и push-in выполнены | То же, более чистая последовательность |
| Appearance | Узнаваемость сохранена, мягче/темнее | Стабильнее детали лица и одежды |
| Temporal consistency | Работает, заметнее blur/колебания | Чище и стабильнее в этом shot |
| Composition | Конечное положение ближе к фронту в Base V1 | Стабильнее кадр, но V1 не выполнил весь ending text |
| Audio | AAC stereo 32 kHz | AAC stereo 32 kHz |
| Local/API cost | $0 API; GPU/rental cost не посчитан | $0.20 за I1 по promo rate |
| End-to-end | 1179.142 с | 9.144 с |

Вывод ограничен конкретным shot: Max существенно быстрее на текущей конфигурации и визуально чище, но не «лучше по всем критериям» и не всегда побеждает reference/text conflict.

## 14. Latency

Надёжные end-to-end замеры `start → accepted → completed → local file`: I1 9.144 с, FL1 8.911 с, V1 18.578 с, multi-reference 11.110 с. Base I1 на текущем local RTX 3080 Laptop GPU занял 1179.142 с (~19 мин 39 с), то есть Max I1 был примерно в 129 раз быстрее end-to-end. Provider inference меньше общего времени; upload/data transfer, queue polling и download измеряются отдельно. T0 исключён из строгого сравнения из-за исправленного после него polling URL quirk.

## 15. Cost

На дату теста fal показывал launch promo для стандартных T2V/I2V до 2026-09-30: 480P $0.025/с, 768P $0.04/с, 1080P $0.08/с; list rates вдвое выше. Reference-to-video: 480P $0.05/с, 768P $0.08/с, 1080P $0.16/с; первые 4096 reference tokens включены, далее $0.02/1K.

Успешный набор: T0/I1/FL1 = 3×$0.20; V1/MR1 output = 2×$0.40; оценка video-reference input V1 ≈$0.69; итого ≈$2.09. Provider response не вернул actual billing, поэтому это расчётная, а не invoice-сумма. MR1 image refs уложились в free reference allowance. Pricing хранится в catalog, reference и standard endpoints считаются раздельно и помечены датой устаревания promo.

## 16. Найденные provider/API особенности

- Submit URL использует полный operation endpoint, но status/result/cancel — queue root `minimax/h3-max/requests/{id}`. Первоначальный polling по полному endpoint давал неверный путь; adapter исправлен и покрыт тестом.
- fal может возвращать exhausted balance как HTTP 403, поэтому `insufficient_credits` распознаётся до общего `auth`.
- T2V/I2V live responses не вернули seed, хотя schema его допускает; reference responses вернули 5242017.
- При `prompt_expansion_mode=disabled` `expanded_prompt` пришёл `null`.
- Reference output тарифицируется иначе и имеет отдельную token charge.
- H3 Max генерирует только один variant на request; fan-out должен делать route/queue, а не неизвестное provider field.
- Ошибки нормализуются в `auth`, `insufficient_credits`, `rate_limit`, `moderation`, `unsupported_parameter`, `invalid_asset`, `generation_failed`, `provider_error`.

## 17. Что добавлено в SnarkRoute

- Hosted fal adapter с сериализацией документированных H3 Max endpoints, polling/resume/cancel/download, cost/latency и error normalization.
- Provider-only H3 queue session без local worker; Base execution path сохранён.
- H3 Max profile в `/api/h3/models`, доступный при настроенном `FAL_KEY`; H3 Max Turbo зарегистрирован disabled/experimental.
- Studio model selector `H3 Base Local` / `H3 Max Hosted`, hosted/local badge, capability-aware controls и estimate до Queue.
- Hosted result ingestion в существующую H3 history/results структуру с provider/model/endpoint/cost/latency/seed/expanded prompt/provenance.
- Pricing entries для standard/reference modes.
- Реальные evaluation/resume scripts и focused unit tests сериализации, keyframes, invalid fields, queue URL, errors, pricing, metadata ingestion и profile selection.

CameraPath, Base Ref2VA, Import Set и Queue architecture не переделывались.

## 18. Capability matrix H3 Max

| Capability | Статус | Основание |
| --- | --- | --- |
| Text-to-video | verified | MAX-T0 |
| First-frame I2V | verified | MAX-I1 |
| First + Last | verified / limited | MAX-FL1; coherent, не pixel lock |
| Last-frame only | unverified | schema допускает, реального теста нет |
| Semantic image reference | verified | MAX-MR1 |
| Multiple image refs | verified / limited | 2-image identity/appearance sanity; не полный suite |
| Video reference | verified / limited | MAX-V1; сильный motion control, conflict с ending text |
| Audio reference | unverified | документировано, render не выполнен |
| Mixed image/video/audio refs | unverified | документировано в одном endpoint, render не выполнен |
| Native generated audio | verified | 5/5 outputs, stereo AAC 32 kHz |
| Dialogue/lip-sync | unverified | MAX-A1 отклонён из-за balance до job acceptance |
| Prompt expansion | verified | mode serializes; disabled вернул null |
| Seed | verified / provider-limited | accepted; не всегда возвращается response |
| 480P/768P/1080P | documented; 768P verified | реальные тесты только 768P |
| 2K/Regenerate | unsupported in exposed Max API | не переносится из Base |
| FaceSwap/custom LoRA | unsupported | hosted API не принимает локальную LoRA |
| Extreme style transfer | unverified | planned stained-glass sanity не запущен после exhaustion |
| Context IR | unverified / not exposed | нет подтверждённого API mapping |
| CameraPath | not evaluated | явно вне scope этой работы |

## 19. Факты про H3 Max Turbo

Turbo отделён от Max. Официальные IDs: `minimax/h3-max-turbo/text-to-video` и `minimax/h3-max-turbo/image-to-video`; provider fal. Документированы T2V, first/last/end-only I2V, 5–15 с, 480P/768P/1080P, native audio, seed, prompt expansion и target audio. Официальный Turbo reference-to-video endpoint в проверенных источниках не найден, поэтому reference capability = unsupported в текущем adapter.

Promo до 2026-09-30: 480P $0.0125/с, 768P $0.02/с, 1080P $0.04/с; затем list $0.025/$0.04/$0.08. Turbo зарегистрирован как hosted experimental, `selectable=false`; production routing и реальный benchmark не делались. Источники: [Turbo T2V](https://fal.ai/models/minimax/h3-max-turbo/text-to-video/api), [Turbo I2V](https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api).

## 20. Что посмотреть глазами

1. [Общий contact sheet](../../apps/server/data/h3-max-eval/2026-09-27-controlled/review-all.jpg): строки T0, I1, FL1, V1, MR1 — сравнить поворот, push-in, identity и финальную позу.
2. [Base vs Max I1](../../apps/server/data/h3-max-eval/2026-09-27-controlled/compare-base-max-i1.jpg): резкость/детали лица, одежду, стабильность света и framing. Учитывать разницу 960×544 против 1344×768.
3. [Base vs Max V1](../../apps/server/data/h3-max-eval/2026-09-27-controlled/compare-base-max-v1.jpg): насколько video reference управляет timing/motion и где побеждает текстовый ending state.
4. [FL1 final vs target](../../apps/server/data/h3-max-eval/2026-09-27-controlled/compare-fl1-last.jpg): trajectory coherent, но target не является pixel lock.
5. Прослушать [MAX-I1](../../apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-I1/output.mp4) и [Base control](../../apps/server/data/h3-max-eval/2026-09-27-controlled/BASE-I1/output.mp4): room tone, fabric/breath и shutter transient; не считать это завершённым dialogue/lip-sync audit.

Полный machine-readable журнал: [run.json](../../apps/server/data/h3-max-eval/2026-09-27-controlled/run.json). Дополнительные style/dialogue tests требуют пополнения fal balance; обязательные четыре paid API cases и дополнительный multi-image sanity уже завершены.
