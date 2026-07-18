@echo off
setlocal
cd /d "%~dp0"
node scripts\dev-product.mjs brandeshmyg
if errorlevel 1 pause
