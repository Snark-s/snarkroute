@echo off
setlocal EnableExtensions
title SnarkRoute + After Effects Beta

rem ============================================================
rem SnarkRoute + Adobe After Effects Beta launcher
rem Put this BAT in the SnarkRoute repository root.
rem You can drag an .aep file onto this BAT to open it.
rem ============================================================

cd /d "%~dp0"

set "ROOT=%CD%"
set "API_HOST=127.0.0.1"
set "API_PORT=4317"
set "AE_EXE=C:\Program Files\Adobe\Adobe After Effects (Beta)\Support Files\AfterFX (Beta).exe"

rem Prevent SnarkRoute from opening Living Canvas in a browser.
set "SNARKROUTE_AUTO_OPEN=0"

rem Check required files.
if exist "%ROOT%\start-snarkroute.bat" goto check_ae

echo [ERROR] start-snarkroute.bat was not found.
echo Expected:
echo %ROOT%\start-snarkroute.bat
pause
exit /b 1

:check_ae
if exist "%AE_EXE%" goto check_server

echo [ERROR] After Effects Beta was not found.
echo Expected:
echo %AE_EXE%
echo.
echo Edit the AE_EXE line in this BAT if After Effects is installed elsewhere.
pause
exit /b 1

:check_server
echo Checking SnarkRoute server...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$client = New-Object System.Net.Sockets.TcpClient; " ^
  "try { " ^
  "  $result = $client.BeginConnect('%API_HOST%', %API_PORT%, $null, $null); " ^
  "  if ($result.AsyncWaitHandle.WaitOne(800) -and $client.Connected) { exit 0 } " ^
  "  exit 1 " ^
  "} catch { exit 1 } finally { $client.Close() }"

if errorlevel 1 goto start_server

echo SnarkRoute is already running on %API_HOST%:%API_PORT%.
goto start_ae

:start_server
echo Starting SnarkRoute...

start "SnarkRoute" /D "%ROOT%" cmd /k "set SNARKROUTE_AUTO_OPEN=0&&call start-snarkroute.bat"

echo Waiting for SnarkRoute on %API_HOST%:%API_PORT%...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline = (Get-Date).AddSeconds(90); " ^
  "while ((Get-Date) -lt $deadline) { " ^
  "  $client = New-Object System.Net.Sockets.TcpClient; " ^
  "  try { " ^
  "    $result = $client.BeginConnect('%API_HOST%', %API_PORT%, $null, $null); " ^
  "    if ($result.AsyncWaitHandle.WaitOne(1000) -and $client.Connected) { " ^
  "      $client.Close(); exit 0 " ^
  "    } " ^
  "  } catch { } finally { $client.Close() } " ^
  "  Start-Sleep -Milliseconds 700 " ^
  "} " ^
  "exit 1"

if errorlevel 1 goto server_timeout

echo SnarkRoute is ready.
goto start_ae

:server_timeout
echo.
echo [WARNING] SnarkRoute did not answer within 90 seconds.
echo Check the SnarkRoute console for errors.
echo After Effects will still be started.
echo.

:start_ae
echo Starting After Effects Beta...

if "%~1"=="" goto start_ae_without_project

start "" "%AE_EXE%" "%~1"
goto done

:start_ae_without_project
start "" "%AE_EXE%"

:done
exit /b 0
