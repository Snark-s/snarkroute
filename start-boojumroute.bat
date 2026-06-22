@echo off
setlocal
cd /d "%~dp0"
node scripts\dev-product.mjs boojum
if errorlevel 1 pause
