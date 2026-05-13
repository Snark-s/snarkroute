@echo off
setlocal

cd /d "%~dp0"

if "%STUDIO_PORT%"=="" set "STUDIO_PORT=5173"
if "%VITE_API_BASE_URL%"=="" set "VITE_API_BASE_URL=http://127.0.0.1:4317"

echo.
echo BoojumRoute Lab
echo ===============
echo Lab:    http://127.0.0.1:%STUDIO_PORT%
echo API:    %VITE_API_BASE_URL%
echo.

where corepack >nul 2>nul
if errorlevel 1 (
  echo ERROR: Corepack is not available.
  pause
  exit /b 1
)

call corepack pnpm dev:studio
if errorlevel 1 (
  echo.
  echo BoojumRoute Lab failed to start or exited with an error.
  pause
  exit /b 1
)

echo.
echo BoojumRoute Lab stopped.
pause
