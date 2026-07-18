# Брандешмыг

Брандешмыг — второй UI-host для уже существующих Living Canvas Actions. Он открывает сохранённые кнопки как обычные инструменты в независимых вкладках и не показывает нодовый граф.

> Boojum создаёт инструменты.  
> SnarkRoute связывает инструменты в процессы.  
> Брандешмыг запускает инструменты как обычные приложения.

## Запуск

В Windows дважды нажмите `start-brandeshmyg.bat` в корне репозитория. Или запустите:

```powershell
corepack pnpm install
corepack pnpm start:brandeshmyg
```

Одна команда поднимает общий SnarkRoute Runtime на `http://127.0.0.1:4317` и UI Брандешмыга на `http://127.0.0.1:5175`.

Если SnarkRoute уже открыт, в панели **Settings** Living Canvas нажмите **Brandeshmyg** рядом с **Boojum**. SnarkRoute запустит UI, если он ещё не работает.

## Инструменты и пакеты

Инструмент создаётся из collapsed compound workflow в Studio так же, как Living Canvas Button. Новый формат не нужен: Брандешмыг импортирует существующие `.node.json` через кнопку **Import .node.json** или drag and drop. Перед установкой показываются manifest, permissions и warnings.

Библиотека загружается из `GET /api/nodes/canvas-actions`. Один action можно открыть в нескольких вкладках; входы, params, continuation и results остаются независимыми.

## Поддержка

- Inputs: image, video, audio, text.
- Preview/results: image, video, audio, panorama360, splat и text.
- Params: только перечисленные в `canvasAction.dialog.params`.
- Interactive pause: preview готовится общим executor, затем workflow продолжается по session continuation.

Состояние вкладок восстанавливается из local storage. Байты локальных файлов не сохраняются: после перезапуска вкладка останется, но вход нужно выбрать заново.
