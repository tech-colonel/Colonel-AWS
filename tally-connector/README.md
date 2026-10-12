# Colonel Tally Connector

A small Windows app that keeps **agent.accountant** in sync with **Tally**. It runs on
the client's Tally PC, reads Tally over Tally's built-in XML port, and pushes the
data to agent.accountant every 15 minutes. Admins see it under **Tally** in the
sidebar.

```
Tally (port 9002, company open)  ◀── XML ──  Connector (.exe on the PC)  ── HTTPS ──▶  agent.accountant
                                                                                         /api/tally/connector/*
```

Nothing is installed into Tally (no .tcp / .dll). Each request carries its own inline
TDL, so the connector only needs Tally's host and port.

## Client setup (one time)

1. **Tally:** F1 Help → Settings → Connectivity → Client/Server configuration →
   *TallyPrime acts as* = **Both**, *Port* = **9002**. Restart Tally.
2. **Keep Tally open** with the company loaded. Tally only answers for open companies.
3. **Firewall:** port 9002 must be allowed only if the connector runs on a *different*
   PC than Tally (same office LAN). Nothing needs opening on the internet or on AWS,
   because the connector only makes outbound HTTPS calls to agent.accountant.
4. Double-click `ColonelTallyConnector.exe`. The app window opens. In it:
   - **Tally:** enter the host (`localhost`, or the IP of the PC/server Tally runs on) and
     port (`9002`), then *Test and save*. The open companies appear below.
   - **agent.accountant:** log in with an **admin** email + password (exchanged for a
     connector token; the password is not stored).
   - **Companies to sync:** untick any company you don't want (default = all open companies).
5. It syncs now and every 15 minutes (*Sync now* forces one). The window shows
   agent.accountant / Tally status, one line per company, and the live log.
   **Closing the window does not stop syncing**; start the exe again to reopen the window,
   and use *Quit connector* in the window to stop it.

The app window is a browser in app mode (Edge, else Chrome) talking to the connector on
`127.0.0.1:47615` (this PC only). `Start-Connector.bat` runs the same app but keeps a
console open with the log, which is useful when something fails at startup.

## Commands

```
ColonelTallyConnector.exe            the desktop app (window)
ColonelTallyConnector.exe app        same; --foreground keeps the console, --no-window skips the window
ColonelTallyConnector.exe run        console only: sync now and every N minutes (after setup)
ColonelTallyConnector.exe setup      console: log in again / change host, port, companies
ColonelTallyConnector.exe test       check the Tally AND agent.accountant connections
ColonelTallyConnector.exe dry-run    read everything from Tally, run checks, save a report (sends nothing)
ColonelTallyConnector.exe once       one sync, then exit
ColonelTallyConnector.exe status     show saved settings
ColonelTallyConnector.exe logout
  --company "X"  dry-run: only this company
  --debug        also print debug lines and save raw Tally XML under logs/raw/
  --host X --port N   override the saved Tally address for this run
```

Settings and logs live in `%APPDATA%\ColonelTallyConnector\` (`config.json`,
`logs/connector-YYYY-MM-DD.log`, kept 30 days). When something goes wrong, ask the
client for that day's log file.

## How a sync works

| Step | Tally request | Sent to agent.accountant |
|---|---|---|
| 1 | Company collection: open companies, GUID, `AltVchID` / `AltMstID` | heartbeat + `sync/start` → server says what it already has |
| 2 | Ledger collection: name, group, opening/closing balance, GSTIN | `sync/ledgers` (full list, chunks of 500) |
| 3 | Voucher collection filtered `$AlterID > watermark` | `sync/vouchers` (only new/changed) |
| 4 | Once a day: every voucher GUID | `sync/finish` removes vouchers deleted in Tally |

- **Incremental:** Tally bumps a record's `AlterID` whenever it is created or edited.
  The server stores the last synced AlterID (the *watermark*) and only moves it on a
  successful finish, so a failed sync is simply redone next cycle.
- **Skip when idle:** if the company's `AltVchID`/`AltMstID` haven't changed, nothing is fetched.
- **Restored company:** if Tally's AlterID counter goes backwards, the server resets the
  watermark and does a full resync.

## Development (no Windows / Tally needed)

```bash
npm install
npm run mock-tally          # fake Tally on :9002; type add | edit | del in its terminal
node src/index.js setup     # point at http://localhost:8001, host localhost, port 9002
node src/index.js once --debug
node src/index.js app       # the desktop app window (src/app.js + src/ui.js)
npm test                    # parser + app-window unit tests
npm run build:exe           # → dist/ColonelTallyConnector.exe (Windows x64)
```
