@echo off
setlocal
cd /d "%~dp0"
node scripts\start-launcher.mjs
if errorlevel 1 pause
