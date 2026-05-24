@echo off
setlocal

cd /d "%~dp0"

if "%SNARKROUTE_PORT%"=="" set "SNARKROUTE_PORT=5174"
if "%API_PORT%"=="" set "API_PORT=4317"
if "%VITE_API_BASE_URL%"=="" set "VITE_API_BASE_URL=http://127.0.0.1:%API_PORT%"
set "SNARKROUTE_URL=http://127.0.0.1:%SNARKROUTE_PORT%"
set "API_URL=http://127.0.0.1:%API_PORT%"

echo.
echo SnarkRoute Living Canvas launcher
echo =================================
echo Project: %CD%
echo Canvas:  %SNARKROUTE_URL%
echo API:     %API_URL%
echo Status:  early experimental shell
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
  echo Install a recent Node.js version, then run:
  echo   corepack enable
  pause
  exit /b 1
)

call corepack pnpm --version >nul 2>nul
if errorlevel 1 (
  echo ERROR: pnpm is not available through Corepack.
  echo Run this once, then try again:
  echo   corepack enable
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

call :check_port "%API_PORT%"
if errorlevel 1 (
  echo.
  echo Port %API_PORT% is busy. Checking whether SnarkRoute API is already running...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%API_URL%/api/health'; try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ exit 0 }; exit 1 } catch { exit 1 }"
  if errorlevel 1 (
    echo.
    echo Port %API_PORT% is busy, but the SnarkRoute API did not respond at %API_URL%/api/health.
    echo Close the process using port %API_PORT% or set API_PORT to another value, then try again.
    pause
    exit /b 1
  )
)

call :check_port "%SNARKROUTE_PORT%"
if errorlevel 1 (
  echo.
  echo Port %SNARKROUTE_PORT% is busy. Checking whether SnarkRoute Living Canvas is already running...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%SNARKROUTE_URL%'; try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500 -and $r.Content -match 'SnarkRoute Living Canvas'){ exit 0 }; exit 1 } catch { exit 1 }"
  if errorlevel 1 (
    echo.
    echo Port %SNARKROUTE_PORT% is busy, but SnarkRoute Living Canvas did not respond at %SNARKROUTE_URL%.
    echo Close the process using port %SNARKROUTE_PORT% or change SNARKROUTE_PORT, then try again.
    pause
    exit /b 1
  )
  echo SnarkRoute Living Canvas is already running. Opening %SNARKROUTE_URL% ...
  start "" "%SNARKROUTE_URL%"
  exit /b 0
)

echo Starting SnarkRoute Living Canvas...
start "SnarkRoute Living Canvas" /D "%CD%" cmd /k "set API_PORT=%API_PORT%&& set VITE_API_BASE_URL=%VITE_API_BASE_URL%&& set SNARKROUTE_PORT=%SNARKROUTE_PORT%&& corepack pnpm start:snarkroute"

echo Waiting for SnarkRoute API on %API_URL% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%API_URL%/api/health'; for($i=0; $i -lt 60; $i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ exit 0 } } catch {} Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 (
  echo.
  echo ERROR: SnarkRoute API did not start in time.
  echo Check the "SnarkRoute Living Canvas" window for details.
  pause
  exit /b 1
)

echo Waiting for SnarkRoute on %SNARKROUTE_URL% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%SNARKROUTE_URL%'; for($i=0; $i -lt 60; $i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ exit 0 } } catch {} Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 (
  echo.
  echo ERROR: SnarkRoute Living Canvas did not start in time.
  echo Check the "SnarkRoute Living Canvas" window for details.
  pause
  exit /b 1
)

start "" "%SNARKROUTE_URL%"

echo.
echo SnarkRoute Living Canvas is running.
echo Canvas: %SNARKROUTE_URL%
echo.
exit /b 0

:check_port
powershell -NoProfile -ExecutionPolicy Bypass -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', [int]'%~1'); $client.Close(); exit 1 } catch { exit 0 }"
exit /b %errorlevel%
