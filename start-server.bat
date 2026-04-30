@echo off
cd /d "%~dp0"
echo Starting SnarkRoute Server...
echo URL: http://127.0.0.1:4317
echo.
corepack pnpm dev:server
echo.
echo Server stopped or failed.
pause
