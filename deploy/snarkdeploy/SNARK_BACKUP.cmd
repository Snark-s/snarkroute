@echo off
setlocal EnableExtensions

echo.
echo ============================================
echo   SNARK BACKUP
echo ============================================
echo.

rem 1) Find the recovery folder.
rem If this BAT is inside SnarkBackups, use its own folder.
set "OUT="
if exist "%~dp0SnarkDeploy\snarkdeploy.py" set "OUT=%~dp0"

rem Otherwise scan all mounted drive letters for SnarkBackups.
if not defined OUT (
  for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "$c=Get-PSDrive -PSProvider FileSystem ^| ForEach-Object { Join-Path $_.Root 'SnarkBackups' } ^| Where-Object { Test-Path (Join-Path $_ 'SnarkDeploy\snarkdeploy.py') } ^| Select-Object -First 1; if($c){$c}"`) do set "OUT=%%F"
)

if not defined OUT (
  echo ERROR: Could not find a SnarkBackups folder with portable SnarkDeploy tools.
  echo Connect the recovery disk, or place this BAT inside its SnarkBackups folder.
  goto :fail
)

if "%OUT:~-1%"=="\" set "OUT=%OUT:~0,-1%"
set "TOOLS=%OUT%\SnarkDeploy"

rem 2) Find the password file on ANY mounted drive.
rem You can also set SNARK_KEY_FILE manually.
set "KEY="
if defined SNARK_KEY_FILE if exist "%SNARK_KEY_FILE%" set "KEY=%SNARK_KEY_FILE%"

if not defined KEY (
  for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "$f=Get-PSDrive -PSProvider FileSystem ^| ForEach-Object { Join-Path $_.Root 'SnarkRecoveryKey\SNARK_RECOVERY_PASSWORD.txt' } ^| Where-Object { Test-Path -LiteralPath $_ } ^| Select-Object -First 1; if($f){$f}"`) do set "KEY=%%F"
)

if not defined KEY (
  echo ERROR: Could not find SNARK_RECOVERY_PASSWORD.txt on any connected drive.
  echo Connect the separate password disk containing:
  echo   SnarkRecoveryKey\SNARK_RECOVERY_PASSWORD.txt
  goto :fail
)

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

echo Recovery folder: %OUT%
echo Password file:   %KEY%
echo.

echo [1/3] Checking workstation...
python "%TOOLS%\snarkdeploy.py" doctor
if errorlevel 1 goto :fail

echo.
echo [2/3] Creating recovery bundle...
python "%TOOLS%\snarkdeploy.py" snapshot --output "%OUT%"
if errorlevel 1 goto :fail

echo.
echo [3/3] Creating AES-256 encrypted secrets ZIP...
python "%TOOLS%\secrets_archive.py" backup --output "%OUT%" --key-file "%KEY%"
if errorlevel 1 goto :fail

echo.
echo ============================================
echo   BACKUP COMPLETE
echo ============================================
echo Recovery files: %OUT%
echo Password file:  %KEY%
echo Keep the recovery disk and password disk physically separate.
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
