@echo off
setlocal

cd /d "%~dp0"

echo.
echo Stop SnarkRoute
echo ===============
echo.
echo Safe MVP stop:
echo   Close the "SnarkRoute Server" and "SnarkRoute Studio" windows.
echo.
echo This script will not kill all node.exe processes because that could close
echo other projects running on your machine.
echo.
echo If a port is still busy after closing the windows, check Task Manager for
echo node.exe processes launched from this SnarkRoute folder:
echo   %CD%
echo.
pause
