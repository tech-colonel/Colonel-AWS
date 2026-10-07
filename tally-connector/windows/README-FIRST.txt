COLONEL TALLY CONNECTOR - quick start
=====================================
Sends your Tally data to agent.accountant (https://agent.accountant) every 15 minutes,
so books, vouchers, GST, receivables and stock show up on the web dashboard.

BEFORE YOU START (once, in Tally)
  1. F1 (Help) > Settings > Connectivity > Client/Server configuration
       TallyPrime acts as = Both        Port = 9002
  2. Restart Tally and OPEN the company you want to sync. Tally only shares open companies.

INSTALL
  1. Unzip this folder anywhere (e.g. Desktop). Do not run it from inside the zip.
  2. Double-click  Start-Connector.bat   (or ColonelTallyConnector.exe).
     Windows may say "Windows protected your PC" - click More info > Run anyway.
     (The app is not code-signed yet.)
  3. In the window that opens:
       Tally:            host = localhost (Tally on this PC) or the IP of the PC/server running
                         Tally; port = 9002. Click "Test and save". Your companies appear.
       agent.accountant: log in with your agent.accountant ADMIN email and password.
       Companies:        untick any you do not want to sync.
  4. It syncs straight away. The first sync of a big company can take several minutes.
     Then open agent.accountant > Tally Dashboard to see the data.

DAILY USE
  - Closing the window does NOT stop syncing. Start the exe again to reopen it.
  - "Sync now" forces a sync. "Quit connector" stops it.
  - Keep Tally open with the company loaded, and this PC on.

IF SOMETHING GOES WRONG
  - Red "Tally not connected":   Tally is closed, no company open, wrong host/port, or the
                                 firewall blocks 9002 (only matters if Tally is on another PC).
  - Red "agent.accountant not connected": no internet, or log in again.
  - Run Diagnose.bat and send us diagnose-output.txt, plus the newest file in
    %APPDATA%\ColonelTallyConnector\logs\

PRIVACY
  Only outbound HTTPS to agent.accountant. Nothing is installed into Tally and no port is
  opened to the internet. Your password is not stored on the PC (a revocable token is).
  An admin can disconnect this PC any time from agent.accountant > Tally.
