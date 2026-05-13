@echo off
setlocal

set "SR_ROOT=%~dp0"

set "BOOJUM_TARGET=%SR_ROOT%start-boojumroute.bat"
set "BOOJUM_ICON=%SR_ROOT%docs\images\BoojumRoute.ico"
set "BOOJUM_SHORTCUT=%SR_ROOT%STARTBoojum.lnk"

if not exist "%BOOJUM_TARGET%" (
    echo File not found:
    echo %BOOJUM_TARGET%
    pause
    exit /b 1
)

if not exist "%BOOJUM_ICON%" (
    echo Icon not found:
    echo %BOOJUM_ICON%
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$wsh = New-Object -ComObject WScript.Shell; ^
$shortcut = $wsh.CreateShortcut($env:BOOJUM_SHORTCUT); ^
$shortcut.TargetPath = $env:BOOJUM_TARGET; ^
$shortcut.WorkingDirectory = $env:SR_ROOT; ^
$shortcut.IconLocation = $env:BOOJUM_ICON; ^
$shortcut.Save()"

echo STARTBoojum shortcut created.

