@echo off
setlocal EnableExtensions

set "OUT=%~dp0"
set "TOOLS=%OUT%SnarkDeploy"
set "KEY=I:\SnarkRecoveryKey\SNARK_RECOVERY_PASSWORD.txt"

echo.
echo ============================================
echo   SNARK RESTORE
echo ============================================
echo.

for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "$f=Get-ChildItem -LiteralPath '%OUT%' -Filter 'snark-recovery-*.zip' ^| Sort-Object LastWriteTime -Descending ^| Select-Object -First 1; if($f){$f.FullName}"`) do set "BUNDLE=%%F"

if not defined BUNDLE (
  echo ERROR: No snark-recovery-*.zip found in:
  echo %OUT%
  goto :fail
)

if not exist "%TOOLS%\bootstrap.ps1" (
  echo ERROR: Portable SnarkDeploy tools are missing:
  echo %TOOLS%
  goto :fail
)

echo Recovery bundle:
echo %BUNDLE%
echo.

powershell -ExecutionPolicy Bypass -File "%TOOLS%\bootstrap.ps1" -Bundle "%BUNDLE%"
if errorlevel 1 goto :fail

echo.
choice /C YN /N /M "Restore encrypted secret files too? [Y/N] "
if errorlevel 2 goto :done

for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "$f=Get-ChildItem -LiteralPath '%OUT%' -Filter 'snark-secrets-*.zip' ^| Sort-Object LastWriteTime -Descending ^| Select-Object -First 1; if($f){$f.FullName}"`) do set "SECRETZIP=%%F"

if not defined SECRETZIP (
  echo No snark-secrets-*.zip found. Skipping secrets.
  goto :done
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); python '%TOOLS%\secrets_archive.py' restore '%SECRETZIP%' --key-file '%KEY%'"
if errorlevel 1 goto :fail

:done
echo.
echo ============================================
echo   RESTORE COMPLETE
echo ============================================
echo FreeToken may still require sign-in again.
echo.
pause
exit /b 0

:fail
echo.
echo ============================================
echo   RESTORE FAILED
echo ============================================
echo See the error above.
echo.
pause
exit /b 1
