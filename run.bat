@echo off
setlocal
cd /d "%~dp0"

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0run.ps1" %*
if errorlevel 1 (
    echo.
    echo Ada masalah saat menjalankan Isle.
    pause
)
