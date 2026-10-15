@echo off
rem Starts the Colonel Tally Connector and keeps this window open afterwards,
rem so any error message stays readable. Double-click this instead of the .exe.
title Colonel Tally Connector
cd /d "%~dp0"
if not exist "%~dp0ColonelTallyConnector.exe" (
  echo ColonelTallyConnector.exe is missing from this folder.
  echo If you copied it here, Windows Defender may have removed it - see Diagnose.bat.
  pause
  exit /b 1
)
rem No arguments = the app, kept in this window so its log and any error stay visible.
if "%~1"=="" (
  "%~dp0ColonelTallyConnector.exe" app --foreground
) else (
  "%~dp0ColonelTallyConnector.exe" %*
)
echo.
echo Connector stopped (exit code %ERRORLEVEL%).
pause
