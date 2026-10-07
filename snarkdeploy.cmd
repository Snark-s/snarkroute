@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if not errorlevel 1 (
  python deploy\snarkdeploy\snarkdeploy.py %*
  exit /b %errorlevel%
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 deploy\snarkdeploy\snarkdeploy.py %*
  exit /b %errorlevel%
)
echo Python is not installed. Run deploy\snarkdeploy\bootstrap.ps1 first.
exit /b 1
