@echo off
setlocal

cd /d "%~dp0"

echo.
echo Stop SnarkRoute
echo ===============
echo.

if "%API_PORT%"=="" set "API_PORT=4317"
if "%STUDIO_PORT%"=="" set "STUDIO_PORT=5173"
if "%SNARKROUTE_PORT%"=="" set "SNARKROUTE_PORT=5174"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-snarkroute.ps1"
taskkill /T /F /FI "IMAGENAME eq cmd.exe" /FI "WINDOWTITLE eq SnarkRoute API*" >nul 2>nul
taskkill /T /F /FI "IMAGENAME eq cmd.exe" /FI "WINDOWTITLE eq BoojumRoute Lab*" >nul 2>nul

echo.
echo Stop request sent.
