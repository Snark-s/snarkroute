@echo off
cd /d "%~dp0"
echo Starting SnarkRoute Server...
echo URL: http://127.0.0.1:4317
echo.
echo Building backend packages...
corepack pnpm --filter @snarkroute/protocol build
if errorlevel 1 goto fail
corepack pnpm --filter @snarkroute/executor build
if errorlevel 1 goto fail
corepack pnpm --filter @snarkroute/storage build
if errorlevel 1 goto fail
corepack pnpm --filter @snarkroute/nodes build
if errorlevel 1 goto fail
corepack pnpm --filter @snarkroute/replicate build
if errorlevel 1 goto fail
corepack pnpm dev:server
echo.
echo Server stopped or failed.
pause
exit /b 0

:fail
echo.
echo Server dependency build failed.
pause
exit /b 1
