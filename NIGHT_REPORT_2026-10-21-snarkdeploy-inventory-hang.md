# Ночная работа — 21.10.2026

## Область и ограничения

- Worktree: `Y:\build\sr-inventory`.
- Ветка: `build/2026-10-21-snarkdeploy-inventory-hang`.
- Рабочие копии вне этого worktree, живые службы, браузер и GUI не трогались.
- Реальные `nvidia-smi`, Ollama, WSL и другие системные inventory-пробы не запускались. GPU/CUDA не использовались.
- Реальный snapshot/архив не создавался; архивы в тестах создавались только во временных каталогах с моками.

## Что сделано

1. Найдена причина зависания в `deploy/snarkdeploy/snarkdeploy.py`: вызов `nvidia-smi` в system inventory шёл через обычный `run()` без timeout. Общий subprocess-слой также не закрывал stdin, поэтому интерактивная внешняя команда могла ждать ввода.
2. Все probe-вызовы system/WSL inventory переведены на `run_probe` с общим timeout по умолчанию 10 секунд. Timeout настраивается через `snapshot --probe-timeout <seconds>` и `doctor --probe-timeout <seconds>`.
3. В subprocess-вызовы добавлен `stdin=subprocess.DEVNULL`. При timeout probe возвращает запись `probe timed out`, timeout не прерывает snapshot и сохраняется в inventory.
4. Ограничены version probes, `nvidia-smi`, WSL, `npm list -g`, `ollama list`, а также GPU-проба в `doctor`.
5. Для `snapshot --component <id>` системный, model и WSL inventory пропускаются. В `system.json` остаётся явная запись `skipped: true` с причиной `component filter`.
6. Добавлены тесты timeout, component-фильтра, GPU timeout через мок и `stdin=DEVNULL`; README дополнен описанием нового параметра.

Разумный выбор без владельца: один настраиваемый timeout 10 секунд для всех внешних inventory-проб. Это сохраняет прежний порядок сбора данных, но исключает бесконечное ожидание; компонентный snapshot по умолчанию не тратит время на глобальные системные данные.

## Проверки

| Команда | Итог |
|---|---|
| `python -m unittest discover -s deploy\\snarkdeploy -p test_snarkdeploy.py` | **OK** — 26 тестов, 1 существующий skip |
| `python -m py_compile deploy\\snarkdeploy\\snarkdeploy.py deploy\\snarkdeploy\\test_snarkdeploy.py` | **OK** |
| `git diff --check` | **OK**; только стандартные предупреждения Git о LF/CRLF |
| `python deploy\\snarkdeploy\\snarkdeploy.py snapshot --help` | **OK**; виден `--probe-timeout` |
| `C:\\Users\\serge\\AppData\\Local\\Programs\\Python\\Python313\\python.exe -m graphify update .` | **OK** — graphify обновил graphify-out: 11 828 nodes, 27 076 edges, 519 communities; Graphify отметил один `.sql` без `tree_sitter_sql` и рассинхрон версии skill 0.9.47/package 0.9.65 |

Ни один из тестов не выполнял реальный GPU/system probe; зависания проверялись через `TimeoutExpired`-моки.

## Что не сделано и почему

- Коммит не создан: sandbox запрещает Git создать `Y:\Процесс\SnarkRoute\.git\worktrees\sr-inventory\index.lock` (`Permission denied`), при этом существующего lock-файла нет. Изменения оставлены незакоммиченными по ночному правилу.
- Настоящий `snarkdeploy snapshot` не запускался, потому что это создало бы реальный архив и могло бы обратиться к живым системным/внешним данным.
- Не запускались реальные `nvidia-smi`, Ollama, WSL, npm inventory и живые сервисы; их поведение покрыто кодом и моками.
- Полные repository-wide тесты не запускались: для локальной правки достаточно focused suite `test_snarkdeploy.py`.

## Строки для листа «Решения»

`D-01 | 21.10.2026 | Codex | Разрешить запись Git metadata для коммита уже проверенных изменений в ветке build/2026-10-21-snarkdeploy-inventory-hang? Зачем: сейчас проверенные изменения и этот отчёт незакоммичены из-за Permission denied на index.lock; сколько стоит: 0 руб., одно действие с правами worktree; что будет при «да»: создать локальные коммиты без merge/push; при «нет»: оставить изменения незакоммиченными для ручного коммита после проверки | разрешить запись и закоммитить / оставить незакоммиченным | | владелец или оператор worktree после проверки` 
