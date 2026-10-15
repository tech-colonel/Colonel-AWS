@echo off
setlocal EnableDelayedExpansion
rem Collects everything needed to debug the connector into diagnose-output.txt
rem (in this folder). Send that file back. It does NOT send anything anywhere.
title Colonel Tally Connector - diagnostics
cd /d "%~dp0"
set OUT="%~dp0diagnose-output.txt"
echo Collecting diagnostics, please wait...

> %OUT% echo ==== Colonel Tally Connector diagnostics %DATE% %TIME%
>> %OUT% echo.
>> %OUT% echo ==== Windows
ver >> %OUT%
>> %OUT% echo PROCESSOR_ARCHITECTURE=%PROCESSOR_ARCHITECTURE% PROCESSOR_ARCHITEW6432=%PROCESSOR_ARCHITEW6432%
>> %OUT% echo.
>> %OUT% echo ==== Files in this folder
dir "%~dp0" >> %OUT% 2>&1
>> %OUT% echo.
>> %OUT% echo ==== Is the exe blocked as "downloaded from the internet"? (Zone.Identifier present = blocked)
powershell -NoProfile -Command "Get-Item -LiteralPath '%~dp0ColonelTallyConnector.exe' -Stream * -ErrorAction SilentlyContinue | Select-Object Stream,Length | Format-Table -AutoSize | Out-String" >> %OUT% 2>&1
>> %OUT% echo ==== Windows Defender detections (may need admin)
powershell -NoProfile -Command "Get-MpThreatDetection -ErrorAction SilentlyContinue | Select-Object InitialDetectionTime,ActionSuccess,Resources | Format-List | Out-String -Width 300" >> %OUT% 2>&1
>> %OUT% echo.
>> %OUT% echo ==== Tally port 9002
powershell -NoProfile -Command "Test-NetConnection -ComputerName localhost -Port 9002 -WarningAction SilentlyContinue | Select-Object ComputerName,RemotePort,TcpTestSucceeded | Format-List | Out-String" >> %OUT% 2>&1
netstat -ano | findstr :9002 >> %OUT% 2>&1
>> %OUT% echo.
>> %OUT% echo ==== Is Tally running, and which ports is it listening on?
powershell -NoProfile -Command "$p = Get-Process | Where-Object { $_.ProcessName -match 'tally' }; if (-not $p) { 'Tally is NOT running' } else { $p | Select-Object Id,ProcessName,Path | Format-Table -AutoSize | Out-String -Width 300; $l = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $p.Id -contains $_.OwningProcess }; if ($l) { 'Tally is listening on:'; $l | Select-Object LocalAddress,LocalPort | Format-Table -AutoSize | Out-String } else { 'Tally is running but NOT listening on any port - enable it: F1 Help, Settings, Connectivity, Client/Server configuration, TallyPrime acts as = Both, Port = 9002, then restart Tally' } }" >> %OUT% 2>&1
>> %OUT% echo.
>> %OUT% echo.
>> %OUT% echo ==== Which program shows the Tally window? (mstsc/RDP/AnyDesk = Tally runs on ANOTHER computer)
powershell -NoProfile -Command "$w = Get-Process | Where-Object { $_.MainWindowTitle -match 'tally' }; if ($w) { $w | Select-Object ProcessName,Id,MainWindowTitle,Path | Format-List | Out-String -Width 300 } else { 'No window with Tally in its title on this computer' }" >> %OUT% 2>&1
>> %OUT% echo ==== Remote-desktop style programs running
powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -match 'mstsc|msrdc|rdpclip|anydesk|teamviewer|vmware|virtualbox|vmconnect|citrix|wfica' } | Select-Object ProcessName,Id,MainWindowTitle | Format-Table -AutoSize | Out-String -Width 300" >> %OUT% 2>&1
>> %OUT% echo ==== This PC's network addresses
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' } | Select-Object InterfaceAlias,IPAddress | Format-Table -AutoSize | Out-String" >> %OUT% 2>&1
>> %OUT% echo.
>> %OUT% echo ==== Crash logs
if exist "%~dp0ColonelTallyConnector-crash.log" type "%~dp0ColonelTallyConnector-crash.log" >> %OUT%
if exist "%TEMP%\ColonelTallyConnector-crash.log" type "%TEMP%\ColonelTallyConnector-crash.log" >> %OUT%
>> %OUT% echo.
if exist "%~dp0ColonelTallyConnector.exe" (
  >> %OUT% echo ==== connector: test --debug
  "%~dp0ColonelTallyConnector.exe" test --debug >> %OUT% 2>&1
  >> %OUT% echo exit code !ERRORLEVEL!
  >> %OUT% echo.
  >> %OUT% echo ==== connector: dry-run
  "%~dp0ColonelTallyConnector.exe" dry-run >> %OUT% 2>&1
  >> %OUT% echo exit code !ERRORLEVEL!
) else (
  >> %OUT% echo ColonelTallyConnector.exe NOT FOUND in this folder - likely removed by antivirus.
)

type %OUT%
echo.
echo Saved to %OUT%
pause
