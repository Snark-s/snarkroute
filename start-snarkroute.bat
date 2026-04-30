@echo off
setlocal

cd /d "%~dp0"

echo.
echo SnarkRoute launcher
echo ====================
echo Project: %CD%
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

echo.
echo Starting SnarkRoute server on http://127.0.0.1:4317
start "SnarkRoute Server" "%~dp0start-server.bat"

timeout /t 3 /nobreak >nul

echo Starting SnarkRoute Studio on http://127.0.0.1:5173
start "SnarkRoute Studio" "%~dp0start-studio.bat"

timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:5173"

echo.
echo Open Studio:
echo   http://127.0.0.1:5173
echo.
echo API health:
echo   http://127.0.0.1:4317/api/health
echo.
echo Close the two launched terminal windows to stop SnarkRoute.
echo.
exit /b 0
