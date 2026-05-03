@echo off
setlocal

cd /d "%~dp0"

set "API_PORT=4317"
set "STUDIO_PORT=5173"
set "VITE_API_BASE_URL=http://127.0.0.1:%API_PORT%"
set "API_URL=http://127.0.0.1:%API_PORT%"
set "STUDIO_URL=http://127.0.0.1:%STUDIO_PORT%"

echo.
echo SnarkRoute launcher
echo ====================
echo Project: %CD%
echo API:    %API_URL%
echo Studio: %STUDIO_URL%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not in PATH.
  echo Install Node.js 20+ and run this file again.
  pause
  exit /b 1
)

where corepack >nul 2>nul
if errorlevel 1 (
  echo ERROR: Corepack is not available.
  echo Install a recent Node.js version and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  corepack pnpm install
  if errorlevel 1 (
    echo.
    echo ERROR: Dependency installation failed.
    pause
    exit /b 1
  )
) else (
  echo Dependencies already installed.
)

call :check_port "%API_PORT%"
if errorlevel 1 (
  echo.
  echo Port %API_PORT% is busy. Another SnarkRoute instance may already be running.
  echo Close it or run stop-snarkroute.bat, then try again.
  pause
  exit /b 1
)

call :check_port "%STUDIO_PORT%"
if errorlevel 1 (
  echo.
  echo Port %STUDIO_PORT% is busy. Another SnarkRoute instance may already be running.
  echo Close it or run stop-snarkroute.bat, then try again.
  pause
  exit /b 1
)

echo.
echo Starting SnarkRoute Server...
start "SnarkRoute Server" "%~dp0start-server.bat"

echo Waiting for API health at %API_URL%/api/health ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%API_URL%/api/health'; for($i=0; $i -lt 60; $i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if($r.StatusCode -eq 200){ exit 0 } } catch {} Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 (
  echo.
  echo ERROR: SnarkRoute API did not start in time.
  echo Check the "SnarkRoute Server" window for details.
  pause
  exit /b 1
)

echo Starting SnarkRoute Studio...
start "SnarkRoute Studio" "%~dp0start-studio.bat"

echo Waiting for Studio on %STUDIO_URL% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%STUDIO_URL%'; for($i=0; $i -lt 60; $i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ exit 0 } } catch {} Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 (
  echo.
  echo ERROR: SnarkRoute Studio did not start in time.
  echo Check the "SnarkRoute Studio" window for details.
  pause
  exit /b 1
)

start "" "%STUDIO_URL%"

echo.
echo SnarkRoute is running.
echo Studio: %STUDIO_URL%
echo API:    %API_URL%
echo.
echo To stop SnarkRoute, close launched windows or run stop-snarkroute.bat
echo.
exit /b 0

:check_port
powershell -NoProfile -ExecutionPolicy Bypass -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', [int]'%~1'); $client.Close(); exit 1 } catch { exit 0 }"
exit /b %errorlevel%
