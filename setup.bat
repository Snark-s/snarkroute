@echo off
setlocal

set "SR_ROOT=%~dp0"

set "BOOJUM_TARGET=%SR_ROOT%start-boojumroute.bat"
set "BOOJUM_ICON=%SR_ROOT%docs\images\BoojumRoute.ico"
set "BOOJUM_SHORTCUT=%SR_ROOT%STARTBoojum.lnk"
set "OLD_SNARK_SHORTCUT=%SR_ROOT%STARTSnark.lnk"

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

if exist "%OLD_SNARK_SHORTCUT%" (
    del "%OLD_SNARK_SHORTCUT%"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$wsh = New-Object -ComObject WScript.Shell; ^
$shortcut = $wsh.CreateShortcut($env:BOOJUM_SHORTCUT); ^
$shortcut.TargetPath = $env:BOOJUM_TARGET; ^
$shortcut.WorkingDirectory = $env:SR_ROOT; ^
$shortcut.IconLocation = $env:BOOJUM_ICON; ^
$shortcut.Save()"

if errorlevel 1 (
    echo Failed to create STARTBoojum shortcut.
    pause
    exit /b 1
)

echo STARTBoojum shortcut created.
echo SnarkRoute shortcut is not created by this setup.
pause
