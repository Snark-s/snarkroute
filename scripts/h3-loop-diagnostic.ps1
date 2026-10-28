$ErrorActionPreference = 'Stop'
& wsl.exe -d Ubuntu-24.04 -- tail -n 35 /home/serge/h3/runtime/local/logs/h3-api.log
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
