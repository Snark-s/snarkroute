@echo off
setlocal
cd /d "I:\ai\FableCut"

if not exist "server.js" (
  echo [ERROR] FableCut not found at I:\ai\FableCut
  pause
  exit /b 1
)

call start.bat
