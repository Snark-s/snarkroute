@echo off
setlocal

cd /d "%~dp0"

if "%API_PORT%"=="" set "API_PORT=4317"
if "%HOST%"=="" set "HOST=127.0.0.1"
if "%STUDIO_PORT%"=="" set "STUDIO_PORT=5173"
if "%VITE_API_BASE_URL%"=="" set "VITE_API_BASE_URL=http://127.0.0.1:%API_PORT%"

set "API_URL=http://127.0.0.1:%API_PORT%"
set "STUDIO_URL=http://127.0.0.1:%STUDIO_PORT%"

echo.
echo BoojumRoute Lab launcher
echo ========================
echo Project: %CD%
echo API:     %API_URL%
echo Lab:     %STUDIO_URL%
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

call corepack pnpm --version >nul 2>nul
if errorlevel 1 (
  echo ERROR: pnpm is not available through Corepack.
  echo Run this from the project folder and check the error:
  echo   corepack pnpm --version
  echo This launcher uses "corepack pnpm" directly and does not require global pnpm.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call corepack pnpm install
  if errorlevel 1 (
    echo.
    echo ERROR: Dependency installation failed.
    pause
    exit /b 1
  )
) else (
  echo Dependencies already installed.
)

echo Preparing workspace packages for BoojumRoute Lab...
call corepack pnpm build:boojumroute-deps
if errorlevel 1 (
  echo.
  echo ERROR: Workspace dependency build failed.
  echo The server needs built package outputs such as packages\nodes\dist\index.js.
  pause
  exit /b 1
)

call :check_port "%API_PORT%"
if errorlevel 1 (
  echo Port %API_PORT% is already in use. Checking for an existing SnarkRoute API...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%API_URL%/api/health'; try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ exit 0 }; exit 1 } catch { exit 1 }"
  if errorlevel 1 (
    echo.
    echo ERROR: Port %API_PORT% is busy, but the SnarkRoute API did not respond at %API_URL%/api/health.
    echo Close the process using port %API_PORT% or set API_PORT to another value, then try again.
    pause
    exit /b 1
  )
  echo Existing SnarkRoute API detected.
) else (
  echo Starting local API server...
  start "SnarkRoute API" /D "%CD%" cmd /c "set API_PORT=%API_PORT%&& set HOST=%HOST%&& corepack pnpm dev:server"
  echo Waiting for API health at %API_URL%/api/health ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%API_URL%/api/health'; for($i=0; $i -lt 60; $i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ exit 0 } } catch {} Start-Sleep -Seconds 1 }; exit 1"
  if errorlevel 1 (
    echo.
    echo ERROR: API server did not become ready in time.
    echo Check the "SnarkRoute API" window for details.
    pause
    exit /b 1
  )
)

call :check_port "%STUDIO_PORT%"
if errorlevel 1 (
  echo Port %STUDIO_PORT% is already in use. Checking for an existing BoojumRoute Lab...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%STUDIO_URL%'; try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ exit 0 }; exit 1 } catch { exit 1 }"
  if errorlevel 1 (
    echo.
    echo ERROR: Port %STUDIO_PORT% is busy, but BoojumRoute Lab did not respond at %STUDIO_URL%.
    echo Close the process using port %STUDIO_PORT% or set STUDIO_PORT to another value, then try again.
    pause
    exit /b 1
  )
  echo BoojumRoute Lab appears to be already running.
) else (
  echo Starting BoojumRoute Lab...
  start "BoojumRoute Lab" /D "%CD%" cmd /c "set STUDIO_PORT=%STUDIO_PORT%&& set VITE_API_BASE_URL=%VITE_API_BASE_URL%&& corepack pnpm dev:studio"
  echo Waiting for BoojumRoute Lab at %STUDIO_URL% ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%STUDIO_URL%'; for($i=0; $i -lt 60; $i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ exit 0 } } catch {} Start-Sleep -Seconds 1 }; exit 1"
  if errorlevel 1 (
    echo.
    echo ERROR: BoojumRoute Lab did not start in time.
    echo Check the "BoojumRoute Lab" window for details.
    pause
    exit /b 1
  )
)

start "" "%STUDIO_URL%"

echo.
echo BoojumRoute Lab is running.
echo Lab: %STUDIO_URL%
echo API: %API_URL%
echo.
exit /b 0

:check_port
powershell -NoProfile -ExecutionPolicy Bypass -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', [int]'%~1'); $client.Close(); exit 1 } catch { exit 0 }"
exit /b %errorlevel%
