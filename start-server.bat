@echo off
setlocal

cd /d "%~dp0"

if "%API_PORT%"=="" set "API_PORT=4317"
set "HOST=127.0.0.1"

echo.
echo SnarkRoute Server
echo =================
echo API: http://127.0.0.1:%API_PORT%
echo.

where corepack >nul 2>nul
if errorlevel 1 (
  echo ERROR: Corepack is not available.
  pause
  exit /b 1
)

echo Building backend workspace packages...
call corepack pnpm --filter @snarkroute/protocol build
if errorlevel 1 goto fail
call corepack pnpm --filter @snarkroute/executor build
if errorlevel 1 goto fail
call corepack pnpm --filter @snarkroute/storage build
if errorlevel 1 goto fail
call corepack pnpm --filter @snarkroute/nodes build
if errorlevel 1 goto fail
call corepack pnpm --filter @snarkroute/openrouter build
if errorlevel 1 goto fail
call corepack pnpm --filter @snarkroute/gemini build
if errorlevel 1 goto fail
call corepack pnpm --filter @snarkroute/replicate build
if errorlevel 1 goto fail

call corepack pnpm dev:server
if errorlevel 1 (
  echo.
  echo Server failed to start or exited with an error.
  pause
  exit /b 1
)

echo.
echo Server stopped.
pause
exit /b 0

:fail
echo.
echo Server dependency build failed.
pause
exit /b 1
