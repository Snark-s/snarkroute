@echo off
cd /d "%~dp0"
echo Starting SnarkRoute Studio...
echo URL: http://127.0.0.1:5173
echo.
corepack pnpm dev:studio
echo.
echo Studio stopped or failed.
pause
