# Смотритель: инвентарь backup/deploy 2026-10-20

Проверка только чтением: `deploy/snarkdeploy/README.md`,
`deploy/snarkdeploy/manifest.json`, копия инструментов
`X:\SnarkBackups\SnarkDeploy` и `X:\SnarkBackups\LATEST.txt`. Архивы и
секретные файлы не распаковывались и не копировались.

## Что система заявляет как покрытое

- Git-backed компоненты SnarkRoute, Mixar/PersonaCore, Project Publisher,
  Bonsai и прочие зарегистрированные компоненты: commit, patch и untracked
  overlays по manifest-правилам.
- Сервисный registry и инвентари модельных manifest-файлов.
- Конфигурация/исходники Bonsai без больших GGUF-весов.
- Отдельный `heavy-inventory.json` с путями, размерами и, где возможно,
  хешами тяжёлых моделей; сами веса в обычный ZIP не входят.
- Отдельный зашифрованный secrets-архив; открытые токены и пароли в ordinary
  recovery ZIP не должны попадать.
- Restore tool поддерживает `restore <bundle> --dry-run` и печатает целевые
  пути без записи. Этот код проверен чтением; длинный прогон по архиву 1.49 GB
  в этот запуск не выполнялся.

## Не покрыто или требует сверки

- `.env`, `.env.local`, `.env.production`, `credentials.json`, `secrets.json`,
  логи, `models`, `artifacts` и `reports` явно исключены общим manifest.
- Большие Bonsai/H3/AI-веса не восстанавливаются из обычного архива; нужен
  отдельный перенос по heavy inventory.
- Project Publisher в manifest исключает `data/publisher.sqlite3` и
  `data/settings.yaml`, а `X:\SnarkBackups\LATEST.txt` утверждает, что
  последний архив содержит database/settings. Это противоречие нельзя считать
  доказанным покрытием без владельческого verify по архиву.
- PersonaCore `data` и часть runtime/harness также исключены, кроме явно
  перечисленных inventory-файлов.
- На 2026-10-20 `LATEST.txt` указывает на архив
  `snark-recovery-20261012-201701.zip`; свежий backup этим запуском не создавался.

## Безопасный dry-run

Ожидаемая команда владельца после подтверждения окна обслуживания:

```text
python deploy\snarkdeploy\snarkdeploy.py restore X:\SnarkBackups\snark-recovery-20261012-201701.zip --dry-run
```

Она не должна трогать live paths. Для этого запуска зафиксировано только
наличие такого режима и предыдущая evidence в
`docs/audits/2026-10-11-acceptance/REPORT.md`; новый restore/verify архива не
запускался, чтобы не читать 1.5 GB и не менять запасной компьютер.

Секреты не читались и не копировались. Предложение владельцу: сначала
согласовать, что именно считать покрытием Project Publisher SQLite/settings,
затем выполнить dry-run и отдельно проверить encrypted secrets archive.
