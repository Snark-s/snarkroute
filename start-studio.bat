@echo off
setlocal

cd /d "%~dp0"

echo.
echo BoojumRoute Lab
echo ===============
echo This compatibility launcher now delegates to start-boojumroute.bat.
echo.

if not exist "%~dp0start-boojumroute.bat" (
  echo ERROR: start-boojumroute.bat is missing.
  pause
  exit /b 1
)

call "%~dp0start-boojumroute.bat"
