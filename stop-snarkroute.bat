@echo off
setlocal

cd /d "%~dp0"

echo.
echo Stop SnarkRoute
echo ===============
echo.
echo Safe MVP stop:
echo   Close the "SnarkRoute Living Canvas", "SnarkRoute Server",
echo   and "BoojumRoute Lab" windows.
echo.
echo This script will not kill all node.exe processes because that could close
echo other projects running on your machine.
echo.
echo If port 4317, 5173, or 5174 is still busy after closing the windows,
echo check Task Manager for node.exe processes launched from this folder:
echo   %CD%
echo.
pause
