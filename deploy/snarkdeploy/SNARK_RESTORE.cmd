@echo off
setlocal EnableExtensions

echo.
echo ============================================
echo   SNARK RESTORE
echo ============================================
echo.

rem Find the recovery folder. Drive letters do NOT matter.
set "OUT="
if exist "%~dp0SnarkDeploy\bootstrap.ps1" set "OUT=%~dp0"

if not defined OUT (
  for %%D in (A B C D E F G H I J K L M N O P Q R S T U V W X Y Z) do (
    if not defined OUT if exist "%%D:\SnarkBackups\SnarkDeploy\bootstrap.ps1" if exist "%%D:\SnarkBackups\snark-recovery-*.zip" set "OUT=%%D:\SnarkBackups"
  )
)

if not defined OUT (
  echo ERROR: Could not find a SnarkBackups recovery folder.
  echo Connect the recovery disk, or place this BAT inside its SnarkBackups folder.
  goto :fail
)

if "%OUT:~-1%"=="\" set "OUT=%OUT:~0,-1%"
set "TOOLS=%OUT%\SnarkDeploy"

for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "$f=Get-ChildItem -LiteralPath '%OUT%' -Filter 'snark-recovery-*.zip' ^| Sort-Object LastWriteTime -Descending ^| Select-Object -First 1; if($f){$f.FullName}"`) do set "BUNDLE=%%F"

if not defined BUNDLE (
  echo ERROR: No snark-recovery-*.zip found in:
  echo %OUT%
  goto :fail
)

echo Recovery folder:
echo %OUT%
echo.
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

rem secrets_archive.py searches ALL drive letters for SnarkRecoveryKey.
rem If the password disk has a different letter on this PC, that is fine.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); python '%TOOLS%\secrets_archive.py' restore '%SECRETZIP%'"
if errorlevel 1 goto :fail

:done
echo.
echo ============================================
echo   RESTORE COMPLETE
echo ============================================
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
