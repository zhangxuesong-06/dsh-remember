@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
title Memory migration

echo ============================================
echo Memory migration: one directory, multiple streams
echo.
echo This window will:
echo   1. stop OpenCode and opencode-cli
echo   2. copy or sync the three old stores into %USERPROFILE%\.agent-memory
echo   3. verify and write activation.log
echo.
echo Close DSH and WorkBuddy first.
echo OpenCode will be stopped in 5 seconds. Press Ctrl+C to cancel.
echo ============================================
timeout /t 5 >nul

taskkill /IM OpenCode.exe /F /T >nul 2>&1
timeout /t 1 >nul
taskkill /IM opencode-cli.exe /F /T >nul 2>&1
timeout /t 2 >nul

if exist "%USERPROFILE%\.agent-memory" (
  node agent-memory\migrate.mjs --sync
) else (
  node agent-memory\migrate.mjs --apply
)
if errorlevel 1 (
  echo.
  echo Migration failed. Make sure DSH and WorkBuddy are closed, then run this file again.
  pause
  exit /b 1
)

if not exist "%USERPROFILE%\.agent-memory" mkdir "%USERPROFILE%\.agent-memory"
echo === %DATE% %TIME% === >> "%USERPROFILE%\.agent-memory\activation.log"
node agent-memory\recall.mjs sources >> "%USERPROFILE%\.agent-memory\activation.log" 2>&1
node tools\mem.mjs health >> "%USERPROFILE%\.agent-memory\activation.log" 2>&1

echo.
echo Done. Restart OpenCode, DSH and WorkBuddy.
echo Log: %USERPROFILE%\.agent-memory\activation.log
echo.
echo --- sources ---
node agent-memory\recall.mjs sources
echo.
echo --- health ---
node tools\mem.mjs health
echo.
pause
