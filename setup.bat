@echo off
setlocal

set "SR_ROOT=%~dp0"

set "SNARK_TARGET=%SR_ROOT%start-snarkroute.bat"
set "SNARK_ICON=%SR_ROOT%docs\images\SnarkRoute.ico"
set "SNARK_SHORTCUT=%SR_ROOT%STARTSnark.lnk"

set "BOOJUM_TARGET=%SR_ROOT%start-boojumroute.bat"
set "BOOJUM_ICON=%SR_ROOT%docs\images\BoojumRoute.ico"
set "BOOJUM_SHORTCUT=%SR_ROOT%STARTBoojum.lnk"

set "SETUP_FAILED=0"

call :create_shortcut "STARTSnark" "%SNARK_TARGET%" "%SNARK_ICON%" "%SNARK_SHORTCUT%"
call :create_shortcut "STARTBoojum" "%BOOJUM_TARGET%" "%BOOJUM_ICON%" "%BOOJUM_SHORTCUT%"

if "%SETUP_FAILED%"=="1" (
    echo.
    echo One or more shortcuts could not be created.
    pause
    exit /b 1
)

echo Setup complete.
pause
exit /b 0

:create_shortcut
set "SHORTCUT_NAME=%~1"
set "SHORTCUT_TARGET=%~2"
set "SHORTCUT_ICON=%~3"
set "SHORTCUT_PATH=%~4"

if not exist "%SHORTCUT_TARGET%" (
    echo %SHORTCUT_NAME% shortcut skipped because target is missing:
    echo %SHORTCUT_TARGET%
    exit /b 0
)

if not exist "%SHORTCUT_ICON%" (
    echo %SHORTCUT_NAME% shortcut skipped because icon is missing:
    echo %SHORTCUT_ICON%
    exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$wsh = New-Object -ComObject WScript.Shell; ^
$shortcut = $wsh.CreateShortcut($env:SHORTCUT_PATH); ^
$shortcut.TargetPath = $env:SHORTCUT_TARGET; ^
$shortcut.WorkingDirectory = $env:SR_ROOT; ^
$shortcut.IconLocation = $env:SHORTCUT_ICON; ^
$shortcut.Save()"

if errorlevel 1 (
    echo Failed to create %SHORTCUT_NAME% shortcut.
    set "SETUP_FAILED=1"
) else (
    echo %SHORTCUT_NAME% shortcut created.
)

exit /b 0
