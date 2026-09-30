# Colonel Tally Connector: Windows test handoff

**For:** Claude running on a Windows PC that has TallyPrime installed.
**From:** the developer working on the Colonel-AWS codebase, via the user.
**Connector version:** 0.1.0 (`ColonelTallyConnector.exe`)

## 1. Your job

Test the connector against the **real Tally** on this PC, find what doesn't work, and
write an **issue report** (template in section 9). The user will pass it back to the
developer, who will fix the code.

Rules:
- **Do not edit or rebuild the connector.** You only have the `.exe` bundle. Diagnose and report.
- **Do not change the company's books.** No vouchers or ledgers created, altered or deleted,
  unless the user explicitly says to and it's a **test company**.
- Changing Tally's connectivity settings (step 3.1) is fine **after telling the user**.
- The logs and reports contain **real financial data**. In your report, include only what's
  needed to explain an issue (counts, tag names, a trimmed XML snippet). Ask the user
  before including party names or amounts.

## 1a. First: getting the app to start

The user reported that double-clicking the earlier `ColonelTallyConnector.exe` **did not
open**. That build had no crash handling, so the cause is unknown. This bundle
(`ColonelTallyConnector.zip`) adds:
- `Start-Connector.bat`: runs the exe and **keeps the window open** afterwards;
- `Diagnose.bat`: collects Windows info, Defender detections, the "blocked download" flag,
  the port 9002 status, crash logs, and the `test` + `dry-run` output into `diagnose-output.txt`;
- a crash guard: any startup error is printed, saved to `ColonelTallyConnector-crash.log`
  (next to the exe and in `%TEMP%`), and the window waits for a key.

Work through these in order and record which one it was:
1. **Extract the zip** to a normal folder, e.g. `C:\ColonelTallyConnector\`. Don't run it from inside the zip.
2. **Check the exe is still there.** If it vanished, **Windows Defender quarantined it**.
   Unsigned apps packaged from Node.js are a known false positive. Check *Windows Security →
   Virus & threat protection → Protection history*. Record the detection name. With the
   user's approval, *Restore* it and add the folder as an exclusion.
3. **SmartScreen** ("Windows protected your PC"): click *More info → Run anyway*.
4. **Downloaded-file block:** right-click the exe → *Properties* → tick **Unblock** → OK.
5. **Run it from a terminal** so the output can't disappear:
   ```powershell
   cd C:\ColonelTallyConnector
   .\ColonelTallyConnector.exe test
   ```
   The first line should be `Colonel Tally Connector starting…`. If nothing at all prints,
   Windows is stopping it before it runs (steps 2–4), not the app.
6. Run **`Diagnose.bat`** and keep `diagnose-output.txt` for the report.
7. Architecture: the exe is **Windows x64**. It won't run on 32-bit Windows. On Windows-on-ARM
   it should run under emulation. `diagnose-output.txt` records the architecture.

In the report, say exactly what happened: nothing, a window flashed and closed, a
SmartScreen or Defender message, or an error text.

## 1b. This PC's setup: Tally runs on a SERVER (RemoteApp)

**Already confirmed:** on this PC, Tally is a **web RemoteApp**. There is no `tally.exe` here;
the window is drawn by Remote Desktop, and Tally itself runs on a remote server.
So `localhost:9002` will always be refused. The connector must reach **the server's IP**.

A competing product (Riko AI) connected successfully to this kind of setup using host
`10.10.21.206`, port `9002`. That is the server's private IP, shown in Tally's
**F1 → About → Computer information / Network Adapters**. Confirm the current IP with the user.

The goal is to get `test` and `dry-run` working against the server:

1. **The user does this, not you (it's inside the RemoteApp window).** In Tally:
   F1 → Settings → Connectivity → Client/Server configuration → *TallyPrime acts as* = **Both**,
   *Port* = **9002**, save, **fully close and reopen Tally**, then open the company. Also ask the
   user to read the IP from F1 → About → Network Adapters.
2. Check the network path from this PC:
   ```powershell
   Test-NetConnection -ComputerName <server-ip> -Port 9002
   Test-NetConnection -ComputerName <server-ip>            # ping only: is the server reachable at all?
   ```
3. If the port is reachable, run:
   ```powershell
   .\ColonelTallyConnector.exe test    --host <server-ip> --port 9002 --debug
   .\ColonelTallyConnector.exe dry-run --host <server-ip> --port 9002 --debug
   ```
   Then continue with section 3.5 (cross-check the numbers).
4. If the port is **not** reachable, work out which of these it is and report it. **Do not change
   firewall, VPN or server settings yourself.** These are the user's (or their Tally-on-Cloud
   provider's) decisions.
   - The server isn't reachable at all (ping/route fails): this PC may not be on the server's
     network. Check `ipconfig` and `route print` for a 10.10.x.x route. Is a VPN needed?
   - The server is reachable but the port is closed: either Tally wasn't restarted after the
     setting change, the setting didn't save, or the **server's firewall** blocks inbound TCP 9002.
   - Ask the user: when Riko worked with `10.10.21.206:9002`, **was Riko's app running on this
     same PC?** If yes, the network path exists, so suspect the Tally setting or restart.
   - Shared server: if several users run Tally on the same server, only **one** Tally instance can
     own port 9002. A wrong company list or a port conflict points to this.
   - If the provider allows no network access at all, the connector would have to run **inside**
     the RemoteApp server session. Report this; don't attempt it.
5. Never leave port 9002 open to the internet. Tally's XML port has **no password**.

## 2. What this is

The goal is for the client's Tally books to show up on the web app **agent.accountant**.

```
TallyPrime (XML server on port 9002, company open)
      ▲  HTTP POST, XML request with inline TDL
      │
ColonelTallyConnector.exe (on this PC)  ── HTTPS ──▶  agent.accountant (/api/tally/connector/*)
```

- Tally has a built-in XML/HTTP server. Once it's enabled, any program can POST an XML
  `<ENVELOPE>` to `http://localhost:9002` and get data back. **Nothing is installed into
  Tally** (no .tcp/.dll). Each request carries its own TDL collection definition.
- Tally only answers for companies that are **open (loaded)** in it.
- What the connector reads:
  - **Companies:** Name, GUID, BooksFrom, AltVchID, AltMstID.
  - **Ledgers:** Name, Parent, OpeningBalance, ClosingBalance, PartyGSTIN, LedGSTRegDetails, GUID, AlterID.
  - **Vouchers:** Date, VoucherTypeName, VoucherNumber, PartyLedgerName, Narration, GUID, AlterID,
    IsCancelled, IsOptional, and the ledger lines from AllLedgerEntries or LedgerEntries (LedgerName, Amount).
- **Incremental sync:** Tally gives every record an `AlterID` that goes up whenever it
  changes. The connector only fetches vouchers with `$AlterID > last synced`, using a TDL
  `<FILTER>`, in windows of 5,000 AlterIDs.
- **Amount sign:** Tally uses negative = Debit and positive = Credit. A voucher's amount is
  the absolute value of the party ledger's line; if there's no party, it's the total of the credit lines.
- **Dates sent:** SVFROMDATE = company BooksFrom, SVTODATE = 31-Mar of the year after the
  current financial year. Dates are sent as `1-Apr-2024`.

Everything above was tested only against a **mock** Tally. This is the first run against
real Tally, so the most likely problems are:
- field or tag names that differ in this Tally version;
- the response encoding;
- how invoice-mode vouchers expose their ledger lines;
- speed on a large company.

## 3. Phase 1: test the Tally side (do this now)

> agent.accountant does **not** have the connector's backend deployed yet. So `setup`, `once`
> and `run` can't log in; expect `404` or "Invalid credentials". **Phase 1 needs no login.**
> `test` and `dry-run` work without setup and send nothing anywhere.

### 3.1 Tally configuration
1. Open TallyPrime. Check the version: **F1 Help → About**. Note the product, release and
   edition for the report.
2. Go to **F1 Help → Settings → Connectivity → Client/Server configuration**. Set
   **TallyPrime acts as = Both** and **Port = 9002**, save, and **restart Tally**.
   (On Tally ERP 9 this is F12 Configure → Advanced Configuration.)
3. Open the company (or companies) to test. Note how many vouchers the company has; big
   companies matter for timing.

### 3.2 Check the port from PowerShell, independent of the connector
```powershell
Test-NetConnection -ComputerName localhost -Port 9002      # TcpTestSucceeded : True
netstat -ano | findstr :9002                               # a LISTENING line
```
Then send one raw request and look at the reply:
```powershell
$body = @'
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Cos</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="Cos"><TYPE>Company</TYPE><FETCH>Name, GUID, BooksFrom, AltVchID, AltMstID</FETCH></COLLECTION></TDLMESSAGE></TDL>
</DESC></BODY></ENVELOPE>
'@
$r = Invoke-WebRequest -Uri http://localhost:9002 -Method Post -Body $body -ContentType 'text/xml; charset=utf-8' -UseBasicParsing
$r.Headers['Content-Type']; $r.Content
```
Record the `Content-Type` (UTF-8 or UTF-16?) and whether `ALTVCHID` / `ALTMSTID` / `GUID` come back with values.

### 3.3 Connector: connection test
In the folder holding the exe:
```powershell
.\ColonelTallyConnector.exe test --debug
```
It prints a box. For Phase 1 the expected result is:
- **Tally ✔ CONNECTED**, with each open company listed;
- **agent.accountant ✘ NOT CONNECTED — not logged in** (this is normal in Phase 1).

If Tally isn't on this PC, add `--host <ip> --port 9002`.

### 3.4 Connector: dry run (the main test)
```powershell
.\ColonelTallyConnector.exe dry-run --debug
.\ColonelTallyConnector.exe dry-run --debug --company "Exact Company Name"   # one company only
```
This reads everything a real sync would read and prints `PASS` / `WARN` / `FAIL` checks:
- company GUID and AltVchID reported
- ledgers fetched and closing balances parsed
- vouchers fetched, and the voucher count matches the GUID list
- every voucher has a date, ledger lines, a non-zero amount and an AlterID
- **the incremental `$AlterID > N` filter works**

It then saves `dry-run-<timestamp>.json` (see section 5). Time how long it takes on the biggest company.

### 3.5 Cross-check the numbers against Tally itself
Open the dry-run JSON. For one company:
- **Voucher counts by type** (`vouchers_by_type`): compare with Tally's
  **Display More Reports → Statistics**, where voucher type counts are shown.
- **Ledger count and closing balances** (`samples.ledgers`): compare 3–5 ledgers with the
  Trial Balance or Ledger report. Remember negative = Dr.
- **A few vouchers** (`samples.vouchers`): open the same voucher in the **Day Book** and
  compare date, type, number, party and amount.
- **Invoice-mode sales/purchase vouchers:** check they have `ledger_entries` and a correct amount.
  This is the part most likely to be wrong.

### 3.6 If a check fails: find the real tag names
With `--debug`, every raw request and response is saved in `logs\raw\`. Open the relevant
`*-response.xml` and note:
- the actual tag names Tally used (for example, is it `ALLLEDGERENTRIES.LIST` or `LEDGERENTRIES.LIST`?
  `PARTYGSTIN` or something inside `LEDGSTREGDETAILS.LIST`?);
- the value formats (dates, amounts);
- any `<LINEERROR>`.

To see one voucher exactly as Tally stores it, export the Day Book for one day:
```powershell
$body = @'
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC>
<REPORTNAME>Day Book</REPORTNAME>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>Exact Company Name</SVCURRENTCOMPANY>
<SVFROMDATE>1-Apr-2025</SVFROMDATE><SVTODATE>1-Apr-2025</SVTODATE></STATICVARIABLES>
</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>
'@
(Invoke-WebRequest -Uri http://localhost:9002 -Method Post -Body $body -ContentType 'text/xml; charset=utf-8' -UseBasicParsing).Content | Out-File daybook-sample.xml
```
Pick a date that has a sales invoice. Compare its structure with what the connector expects (section 2).

## 4. Phase 2: full sync (only after the user says the backend is deployed)
```powershell
.\ColonelTallyConnector.exe setup    # admin email/password, host localhost, port 9002, pick companies
.\ColonelTallyConnector.exe once     # one sync, then prints the status box
.\ColonelTallyConnector.exe          # keeps running; syncs every 15 min, status box after each
```
After each sync the box should show **agent.accountant ✔ CONNECTED (logged in as …)**,
**Tally ✔ CONNECTED**, and one line per company. The window title also says
`Connected` / `Tally NOT connected` / `agent.accountant NOT connected`. The user can check
the data on agent.accountant → **Tally** (admin sidebar). Run `once` a second time: it
should say "up to date (no changes in Tally)".

## 5. Where the files are
`%APPDATA%\ColonelTallyConnector\`
- `config.json`: settings (host, port, companies, connector token; never the password)
- `logs\connector-YYYY-MM-DD.log`: every step, timestamped
- `logs\dry-run-*.json`: dry-run reports
- `logs\raw\*.xml`: raw Tally requests and responses (only with `--debug`)

## 6. Known symptoms and likely causes

| Symptom | Likely cause / what to check |
|---|---|
| `Cannot reach Tally … ECONNREFUSED` | Port not enabled, Tally not restarted after enabling, Tally not running, or wrong port. Check 3.2. |
| `Cannot reach Tally … timed out after 300s` | Very large company or Tally busy. Record the voucher count and which request timed out (log). |
| `Tally error …: Could not set 'SVCurrentCompany'` | Company not open, or the name differs (trailing spaces, special characters). Compare with the names `test` lists. |
| Company list is empty but a company is open | The Company collection field names differ. Look at `ColonelCompanies-response.xml`. |
| `WARN AltVchID reported` | This Tally version doesn't expose `AltVchID` on Company. Sync still works, but more slowly. Note the version. |
| `FAIL Incremental filter` | Tally ignored `$AlterID > N`. Critical: report the `ColonelVouchers-request.xml` / `-response.xml` pair. |
| Vouchers without ledger lines | Invoice-mode vouchers keep lines under a different tag. Report the tag names from a raw response or Day Book sample. |
| Amounts 0/blank, or wrong sign | Amount format differs (currency symbol, forex, `Dr`/`Cr` suffix). Paste 2–3 raw `<AMOUNT>` values. |
| Garbled text / parse error | Encoding issue. Report the `Content-Type` from 3.2 and the first bytes of a raw response. |
| Voucher count ≠ GUID count | Some vouchers are filtered by period or are optional/cancelled. Report both numbers and the date range. |
| Counts differ from Tally's Statistics | Report both sets of numbers by voucher type. |

## 7. Useful Tally facts
- Company names must match exactly, including `&` and trailing text such as `(from 1-Apr-24)`.
- Negative amount = Debit, positive = Credit, in both ledger balances and voucher lines.
- `GUID` is stable per voucher; `AlterID` changes on every edit.

## 8. What "working" means
- `test`: Tally ✔ with the right companies.
- `dry-run`: no `FAIL`. Any `WARN` is explained.
- Voucher counts by type match Tally's Statistics.
- 3–5 ledgers and 3–5 vouchers (including one invoice-mode sale) match Tally.
- Record the dry-run time on the biggest company.

## 9. Report to send back (fill this in)

```markdown
# Tally Connector test report

## Environment
- Windows version:
- TallyPrime version / release / edition:
- Connector version: 0.1.0
- Companies tested (voucher count each):
- Tally on same PC as connector? (yes / no, host used):

## Results
| Step | Result (PASS/WARN/FAIL) | Notes |
|---|---|---|
| 1a App starts (what happened on double-click; Defender/SmartScreen?) | | |
| 3.2 Port 9002 open, raw request answered | | encoding: |
| 3.3 `test` | | |
| 3.4 `dry-run` (paste the PASS/WARN/FAIL lines) | | time taken: |
| 3.5 Voucher counts vs Statistics | | |
| 3.5 Ledger balances vs Trial Balance | | |
| 3.5 Sample vouchers vs Day Book (incl. invoice mode) | | |
| 4 Phase 2 (if done) | | |

## Issues
### Issue 1: <short title>
- Command run:
- What happened (exact error / log lines):
- Expected:
- Evidence: tag names, trimmed raw XML snippet, counts (no party names/amounts unless the user agreed)
- Your diagnosis:

## Attachments the user should send along
- diagnose-output.txt and ColonelTallyConnector-crash.log (if present)
- logs\connector-YYYY-MM-DD.log
- logs\dry-run-*.json
- the relevant logs\raw\*.xml files (only if the user agrees; they contain real data)
```
