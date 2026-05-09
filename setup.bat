@echo off
setlocal

set "SR_ROOT=%~dp0"
set "SR_TARGET=%SR_ROOT%start-snarkroute.bat"
set "SR_ICON=%SR_ROOT%docs\images\SnarkRoute.ico"
set "SR_SHORTCUT=%SR_ROOT%START.lnk"

if not exist "%SR_TARGET%" (
    echo Не найден файл:
    echo %SR_TARGET%
    pause
    exit /b 1
)

if not exist "%SR_ICON%" (
    echo Не найдена иконка:
    echo %SR_ICON%
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$wsh = New-Object -ComObject WScript.Shell; ^
$shortcut = $wsh.CreateShortcut($env:SR_SHORTCUT); ^
$shortcut.TargetPath = $env:SR_TARGET; ^
$shortcut.WorkingDirectory = $env:SR_ROOT; ^
$shortcut.IconLocation = $env:SR_ICON; ^
$shortcut.Save()"

echo Ярлык START создан.
