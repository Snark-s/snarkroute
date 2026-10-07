@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "REPO=Y:\Процесс\SnarkRoute"
set "OUT=X:\SnarkBackups"
set "KEY=I:\SnarkRecoveryKey\SNARK_RECOVERY_PASSWORD.txt"
set "DEPLOY=%REPO%\deploy\snarkdeploy"

echo.
echo ============================================
echo   SNARK BACKUP
echo ============================================
echo.

if not exist "%DEPLOY%\snarkdeploy.py" (
  echo ERROR: SnarkRoute not found at:
  echo %REPO%
  goto :fail
)

if not exist "%OUT%" mkdir "%OUT%"

where python >nul 2>nul
if errorlevel 1 (
  echo ERROR: Python not found.
  goto :fail
)

if not exist "C:\Program Files\7-Zip\7z.exe" (
  echo 7-Zip is missing. Installing...
  winget install --id 7zip.7zip -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 goto :fail
)

echo [1/3] Checking workstation...
python "%DEPLOY%\snarkdeploy.py" doctor
if errorlevel 1 goto :fail

echo.
echo [2/3] Creating recovery bundle...
python "%DEPLOY%\snarkdeploy.py" snapshot --output "%OUT%"
if errorlevel 1 goto :fail

echo.
echo [3/3] Creating AES-256 encrypted secrets ZIP...
python "%DEPLOY%\secrets_archive.py" backup --output "%OUT%" --key-file "%KEY%"
if errorlevel 1 goto :fail

echo.
echo ============================================
echo   BACKUP COMPLETE
echo ============================================
echo Recovery files: %OUT%
echo Password file:  %KEY%
echo.
echo Keep X: and I: physically separate.
echo.
pause
exit /b 0

:fail
echo.
echo ============================================
echo   BACKUP FAILED
echo ============================================
echo See the error above.
echo.
pause
exit /b 1
