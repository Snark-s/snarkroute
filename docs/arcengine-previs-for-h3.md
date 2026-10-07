# ArcEngine как previs / virtual film set для H3

Дата проверки: 2026-09-25.

## Краткий вывод

ArcEngine пригоден как лёгкая browser-based площадка для blocking и генерации структурного
видеореференса. Его сильные стороны — локальный Babylon.js, отсутствие npm-runtime-зависимостей,
простая файловая структура, удобные для coding-agent правила, примитивы Babylon, камера,
свет, тени, toon/render-debug режимы и быстрый цикл проверки.

Upstream ArcEngine не содержит готового timeline, camera keyframes или штатного video export.
Для proof of concept добавлена изолированная previs-сцена и небольшой offline capture helper.
Он задаёт время каждого кадра явно (`frame / fps`), получает PNG через Chrome DevTools Protocol
и собирает H.264 MP4 через ffmpeg. Demo ArcEngine не изменён.

## Установка

- Путь: `I:\AI\ArcEngine`
- Git remote: `https://github.com/xaidan777/ArcEngine.git`
- Ветка: `main`
- Commit: `7aec24a3a6f463bf5fee2aa63d7a17260a871b1b`
- Версия набора: `GAME_VERSION = 0.1.0`
- Babylon.js: `9.26.0`, локально в `libs/babylon.js`
- Node.js при проверке: `v22.19.0`
- ffmpeg: `9.0.2`, установлен для текущего Windows-пользователя через winget

Репозиторий сохранён как обычный git clone: работают `git status`, `git pull`, `git log`,
remote `origin` указывает на upstream. `graphify-out/` исключён только локально через
`.git/info/exclude`; upstream `.gitignore` ради анализа не менялся.

## Запуск

Исходная игра:

```bat
cd /d I:\AI\ArcEngine
run.bat
```

Исходный editor:

```bat
editor.bat
```

Previs smoke scene одним действием:

```bat
start-arcengine.cmd
```

Скрипт открывает `http://localhost:8181/previs/index.html` и запускает штатный no-store
dev server. Другой порт можно передать первым аргументом:

```bat
start-arcengine.cmd 9000
```

## Архитектура ArcEngine, важная для previs

ArcEngine — набор classic-script JavaScript-файлов без bundler:

- `index.html` задаёт обязательный порядок загрузки;
- `js/Constants.js` содержит числовые настройки;
- `js/World3D.js` создаёт Babylon Engine, View3D, камеру, свет, тени, toon, ink и outline;
- `js/Terrain3D.js` и `js/Location3D.js` создают terrain/location;
- `js/Objects.js` — data-файл расставленных FBX/GLB-объектов;
- `js/CameraControl.js` — интерактивная игровая/свободная камера;
- `js/Game.js` — место покадровой логики;
- `js/Debug3D.js` — scene lint, held camera, synchronous frames и debug views;
- `_utils/editor/` — визуальный редактор constants, objects, UI и sound;
- `tools/check.mjs` — типы и Node-тесты;
- `tools/dev-server.mjs` — локальный сервер с `Cache-Control: no-store`.

Система координат: карта `(x, y, height)` переходит в Babylon `(X=x, Z=y, Y=height)`.
Сцена right-handed. Условно удобно принять `100 world units = 1 metre`.

### Что сначала читает coding-agent

1. `README.md` и `CLAUDE.md`.
2. `claude/skills/world3d/SKILL.md`.
3. `claude/skills/build/SKILL.md`.
4. Перед визуальной проверкой — `claude/skills/verify/SKILL.md`.
5. Перед своей геометрией/светом — `claude/skills/render-conventions/SKILL.md`.
6. Для PoC — `previs/README.md`, `previs/index.html`, `previs/scene.js`.

## Программная постановка сцены

Примитив создаётся напрямую через Babylon и регистрируется в ArcEngine:

```js
const mesh = BABYLON.MeshBuilder.CreateBox('crate', {
    width: 100, height: 100, depth: 100
}, view.scene);
mesh.position.set(x, height, z);
mesh.rotation.set(rx, ry, rz);
mesh.scaling.set(sx, sy, sz);
mesh.material = material;
World3D.addObject(view, mesh, 'prop');
```

Это хорошо подходит агенту: композиция выражается обычными числами и коротким JS. Исходный
`Objects.js` удобен для расстановки импортированных FBX/GLB, но не является общим scene DSL
для примитивов и camera timeline. Для Jabberwock лучше добавить отдельный declarative JSON,
который компилируется в такой JS/runtime, а не перегружать `Objects.js`.

## Camera и animation timeline в PoC

Файл `previs/scene.js` создаёт отдельную комнату примерно 8×6 м:

- ground plane;
- две стены;
- стол, лавка и ящик из boxes;
- пять условных деревьев из cylinders/spheres;
- условный персонаж из capsule/sphere;
- штатные hemispheric light и directional sun ArcEngine.

Timeline длится 8 секунд. Персонаж движется из A в B. Камера начинает с общего плана,
делает dolly-in с боковым обходом и заканчивает medium shot. Положение персонажа и камеры
является чистой функцией времени — никакого интегрирования через реальный `dt`.

Agent-facing API страницы:

```js
await window.previs.ready;
window.previs.setTime(4.0);
window.previs.renderFrame(96); // frame 96 at 24 fps == 4.0 seconds
window.previs.setMode('flat');
await window.previs.lint();
```

Поля `duration`, `fps`, `frameCount` и краткое `sceneDescription` также доступны через
`window.previs`. Благодаря этому агент может менять сцену, открыть страницу headless-браузером,
установить нужный кадр, сделать screenshot, оценить изображение vision-моделью и повторить цикл.

## Получение reference video

Команда по умолчанию:

```bat
render-previs.cmd
```

Эквивалент с явными параметрами:

```bat
render-previs.cmd --duration=8 --fps=24 --width=1280 --height=720 --mode=normal
```

Capture реализован в `tools/render-previs.mjs` без npm-зависимостей:

1. запускается штатный ArcEngine dev server;
2. запускается установленный Chrome/Edge в headless-режиме;
3. Node подключается к Chrome DevTools Protocol;
4. для каждого кадра вызывается `window.previs.renderFrame(frame)`;
5. `Page.captureScreenshot` сохраняет `frame_NNNN.png`;
6. ffmpeg собирает PNG в H.264 MP4 (`yuv420p`, 24 fps).

Результат проверки:

- MP4: `I:\AI\ArcEngine\previs\output\preview-normal.mp4`
- PNG: `I:\AI\ArcEngine\previs\output\frames\frame_0000.png` … `frame_0191.png`
- 192 кадра;
- 1280×720;
- 24 fps;
- длительность ровно 8.000 s;
- codec H.264;
- размер MP4 981,537 bytes;
- SHA-256 MP4: `40C802E8AAB6A8A528053A0131950ADFDBC721130732A97F8004A2D2B13B4DD0`.

Можно вывести только контрольные кадры:

```bat
render-previs.cmd --frames=0,96,191 --out=previs/output/check
```

## Детерминизм

Время симуляции детерминировано: frame N всегда получает `time = N / fps`. Скорость browser,
requestAnimationFrame и реальный FPS не влияют на траектории. Повторная проверка кадров 0, 96
и 191 дала одинаковую композицию и трансформы. Кадры 0 и 191 совпали побайтно; у кадра 96
2,650 из 921,600 пикселей отличались на один уровень только зелёного канала. Это остаточная
GPU-растеризация/antialiasing. Поэтому режим детерминирован по времени и постановке, но не
гарантирует битовую идентичность PNG между отдельными browser/GPU runs.

## Специальные reference-режимы

PoC поддерживает:

- `normal` — toon previs со светом и тенями;
- `flat` — плоские object colors;
- `depth` — грубый depth-like grayscale preview;
- `silhouette` — чёрные предметы/персонаж на светлом floor/walls;
- `wireframe` — геометрия Babylon.

Примеры:

```bat
render-previs.cmd --mode=flat
render-previs.cmd --mode=silhouette
render-previs.cmd --mode=wireframe
```

Текущий `depth` — только приближение по расстоянию материалов, не настоящий linear depth pass.
Для H3 стоит следующим этапом сделать отдельный depth render target и отдельную object-ID mask.
Flat colors, silhouette и character marker уже практически полезны как структурные reference inputs.

## Автоматическая проверка

Baseline upstream:

- `node tools/check.mjs` — types game/editor OK;
- 80/80 Node tests passed;
- asset preflight — 8/8 assets present.

Browser smoke:

```bat
node tools/browser-smoke.mjs
```

Результат:

- game: Babylon 9.26.0, исходные 2 объекта загрузились, runtime errors 0;
- editor: исходные 2 объекта загрузились, editor server connected, runtime errors 0;
- previs: 192 frames, установка frame 96 дала time 4.000, runtime errors 0;
- `Debug3D.lint()` на previs-сцене: 0 findings.

Скриншоты smoke test находятся в `previs/output/browser-smoke/`.

## Пригодность как virtual film set

Хорошо:

- LLM быстро понимает небольшой vanilla-JS проект;
- примитивы, transforms, свет и камера доступны программно;
- точная camera trajectory легко задаётся чистой функцией времени;
- объект и камера синхронизируются одним timeline;
- headless visual validation работает;
- локальные библиотеки уменьшают сетевую и package-manager нестабильность;
- Debug3D даёт полезный scene lint и debug views;
- PNG/MP4 можно получить полностью без ручного GUI.

Ограничения upstream:

- нет native camera timeline/keyframe editor;
- нет native video/PNG export;
- нет declarative primitive scene format;
- editor ориентирован на один location и импортированные FBX/GLB;
- `Objects.js` поддерживает looped GLB clips/part spin, но не общий animation graph;
- нет physics/collisions и нескольких сцен;
- обычный captureStream/MediaRecorder зависит от реального FPS; поэтому PoC использует CDP screenshots;
- настоящий depth/object-ID/normal pass ещё не реализован;
- окончательная пригодность конкретного MP4 как input для H3 должна быть проверена отдельным H3 ingestion test.

Итоговая оценка: ArcEngine хорошо подходит для small/medium blocking и agent-driven animatics,
если поверх него добавить очень тонкий scene/timeline DSL и оставить сам ArcEngine renderer/runtime
практически без изменений. Он не должен становиться Blender или полноценным game engine.

## Минимальные изменения

Upstream-файлы `js/*`, editor и demo не переписывались. Добавлены:

- `previs/index.html` — отдельная страница;
- `previs/scene.js` — smoke scene и timeline;
- `previs/README.md` — команды и API;
- `previs/output/.gitignore` — generated media не попадает в git;
- `tools/render-previs.mjs` — deterministic CDP capture + ffmpeg;
- `tools/browser-smoke.mjs` — browser runtime smoke test;
- `start-arcengine.cmd` — one-click preview;
- `render-previs.cmd` — one-click offline render.

Generated outputs существуют локально, но намеренно игнорируются git.

## Концепция Jabberwock

Минимальный публичный вызов:

```python
create_previs(
    description: str,
    duration: float = 8.0,
    fps: int = 24,
    resolution: tuple[int, int] = (1280, 720),
    modes: list[str] = ["normal"]
) -> {
    "project_path": str,
    "preview_video": str,
    "frame_sequence": str,
    "scene_description": str,
    "camera_data": str,
    "render_manifest": str
}
```

Рекомендуемый внутренний pipeline:

```text
description
→ LLM builds declarative scene.json + timeline.json
→ schema validation
→ ArcEngine runtime loads primitives/materials/lights
→ deterministic CDP frame render
→ ffmpeg MP4
→ vision QA on selected frames/contact sheet
→ targeted scene/timeline correction
→ final normal + optional structural modes
→ H3 input
```

Предлагаемый минимальный scene/timeline schema:

```json
{
  "units": "meters",
  "duration": 8,
  "fps": 24,
  "objects": [
    {"id": "table", "primitive": "box", "size": [1.8, 0.08, 0.9], "position": [0, 0.8, 0]},
    {"id": "person_a", "primitive": "character_marker", "position": [-2.5, 0, -1]}
  ],
  "tracks": [
    {"target": "person_a.position", "keys": [[0, [-2.5, 0, -1]], [7, [0, 0, -0.5]]]},
    {"target": "camera", "keys": [{"time": 0, "shot": "wide"}, {"time": 8, "shot": "medium"}]}
  ]
}
```

Следующий этап должен быть небольшим: formal JSON schema, loader/compiler, camera/object tracks,
render manifest и H3 ingestion test. Глубокую интеграцию в SnarkRoute/PersonaCore до этого делать не нужно.

## Graphify

Для архитектурного анализа построен локальный граф в `I:\AI\ArcEngine\graphify-out/`:

- `graph.html` — агрегированная интерактивная карта;
- `GRAPH_REPORT.md` — отчёт;
- `graph.json` — GraphRAG-ready данные.

Граф большой из-за bundled/minified Babylon: 40,600 nodes, 68,366 edges. Для архитектурных
вопросов полезнее ограничивать будущий Graphify-run путями `js/`, `_utils/editor/`, `tools/`,
`tests/`, `claude/` и исключать `libs/*.js`/`*.d.ts`.
