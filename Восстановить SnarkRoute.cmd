@echo off
chcp 65001 >nul
title SnarkRoute API - recovery console
cd /d "Y:\Процесс\SnarkRoute"
echo [Recovery] Starting SnarkRoute API on 127.0.0.1:4317
echo [Recovery] Leave this console open while using the workshop.
echo [Recovery] If the server fails, the error will remain visible.
echo.
call corepack pnpm --filter @snarkroute/server dev
echo.
echo [Recovery] Server process ended (exit code %ERRORLEVEL%).
echo Copy the error above if the service did not start.
pause
