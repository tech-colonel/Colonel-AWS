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
"%~dp0ColonelTallyConnector.exe" %*
echo.
echo Connector stopped (exit code %ERRORLEVEL%).
pause
