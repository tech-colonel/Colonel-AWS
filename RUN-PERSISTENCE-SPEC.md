# 🗂️ Run-Persistence Spec — make EVERY reco agent's run survive an engine restart (LOCAL)

> **Handoff doc for another agent/session.** Self-contained. Goal: every reco agent
> persists its run so the Excel **downloads fast and never 404s** after the Python
> engine restarts. The pattern is already proven & live for 7 agents — this task
> just extends it to the **5 remaining reco types**. Low-risk, mechanical, additive.

---

## 0. Golden rules for this task (do not violate)
1. **LOCAL ONLY.** Do NOT touch AWS/EC2, do NOT `git push`, do NOT deploy. Everything here is the local dev checkout `colonol git/colonel-automation/`.
2. **Back up before editing any file:** `cp -a <file> <file>.bak-$(date +%Y%m%d-%H%M%S)` first.
3. **NEVER change agent / reco logic.** This is a pure output-persistence add. The reconciliation results, sheet layouts, Remark 1/2/3, `.xls`→`.xlsx` conversion — all untouched. You are only building the workbook **once, earlier** and caching its bytes.
4. **Every add is wrapped in `try/except` (Python) so a failure falls back to the existing on-demand rebuild** — persistence must never be able to break a reco response.
5. Compile-check, restart LOCAL engine + backend only, verify, then stop.

---

## 1. Why (the problem)
The Python engine (`reco-engine/server.py`) keeps each run in an **in-memory `JOBS` dict**. When you click **Download Excel** / **Open in Google Sheets**, the backend calls `GET /api/jobs/<id>/export.xlsx`. For agents that don't pre-build, that handler **rebuilds the whole workbook on demand** from `JOBS[job_id]`. So:
- If the engine **restarted** since the run → `JOBS` is empty → **404 "Job not found"**.
- A large rebuild under load → slow → backend timeout → `BrokenPipeError`.

## 2. The fix that already exists (the pattern to copy)
Already implemented in `reco-engine/server.py` (do NOT redo these — they're done):
- **`_JobStore(dict)`** (~line 93): its `__setitem__` auto-writes `payload["_xlsx_bytes"]` to `RECO_OUTPUT_DIR/<job_id>.xlsx` (atomic `.part`→`replace`, best-effort try/except). `JOBS = _JobStore()`. → **any run that sets `_xlsx_bytes` survives a restart, for free.**
- **`export_job()`** (~line 973) is 3-tier: in-memory `_xlsx_bytes` → **disk** (`RECO_OUTPUT_DIR/<id>.xlsx`) → rebuild+persist; final `wfile.write` guarded against `BrokenPipeError`.
- **`_purge_old_exports(3d)`** runs on startup.
- **Pre-build template** — see the `gstr_2b_books` branch (~line 447–467). After `payload` is built, before returning JSON:
  ```python
  # Pre-build the workbook now so Download is instant AND survives an engine
  # restart (the _JobStore persists _xlsx_bytes to disk). Best-effort: on
  # failure export_job rebuilds on demand.
  try:
      from io import BytesIO as _BytesIO
      _wb = build_workbook(
          payload["results"], payload["summary"], payload["counts"],
          reco_type, pivot=payload.get("pivot"), payload=payload,
      )
      _buf = _BytesIO(); _wb.save(_buf)
      payload["_xlsx_bytes"] = _buf.getvalue()
  except Exception:
      payload["_xlsx_bytes"] = None
  JOBS[job_id] = payload
  # Response must NOT include the raw bytes (json.dumps would stringify them):
  self.write_json({k: v for k, v in payload.items() if k != "_xlsx_bytes"})
  ```

## 3. What THIS task adds
Apply the **same pre-build block** to the 5 reco-type branches that still rebuild-on-download. All 5 are already supported by `build_workbook()` (see its `if reco_type == …` chain, ~line 1052), so the workbook builds identically — you're just building it at reconcile instead of at download.

**Branches to patch in `reco-engine/server.py`** (anchor on the `if reco_type == "…":` line — line numbers drift):

| reco_type | Notes for the `build_workbook(...)` call |
|---|---|
| `gstr_3b_vs_2b` | pass `payload["results"], payload["summary"], payload["counts"], reco_type` |
| `gstr_2a_2b_books` | same shape; include `pivot=payload.get("pivot")` if the payload has a pivot |
| `bank_reco` | same shape; check the branch's local var names for results/summary/counts |
| `einvoice_reco` | this type builds a Pivot / After-Pivot — pass `pivot=payload.get("pivot"), payload=payload` |
| `gstr_3b_tally_entry` | same shape |

For each branch:
1. Locate where its `payload` dict is fully assembled and where it does `JOBS[job_id] = payload` (or `self.write_json(payload)`).
2. Insert the try/except pre-build block **just before** `JOBS[job_id] = payload`, adapting the 4 positional args to that branch's actual variable names (some branches build `results`/`summary`/`counts` in locals rather than reading them back out of `payload` — use whatever that branch already has).
3. Make sure the JSON response does **not** serialize `_xlsx_bytes`:
   - If the branch returns via `self.write_json(payload)` → change to `self.write_json({k: v for k, v in payload.items() if k != "_xlsx_bytes"})`.
   - Branches whose `write_json` already **strips `_`-prefixed keys** need no response change (confirm by reading `write_json`).

**Do NOT** add pre-build to types that already have it (§2 list) — you'll double-build.

## 4. "Fast and safe" checklist (the acceptance bar)
- **Fast:** workbook built once at reconcile (already in RAM) → Download serves cached bytes from memory or disk; no rebuild, no 120s timeout.
- **Safe:** every pre-build in `try/except`; on any exception set `_xlsx_bytes = None` and let `export_job` rebuild on demand (current behaviour) — **zero regression** if a build fails.
- **No logic change:** identical `build_workbook()` output; results JSON unchanged; agent code untouched.

## 5. Files
- `reco-engine/server.py` — the 5 branch edits above (back up first).
- (Backend already persists exports via `new-backend/src/controllers/recoController.js` `RECO_OUTPUT_DIR` + 200s timeouts — **no backend change needed** for this task.)

## 6. Procedure (exact)
```bash
cd "colonol git/colonel-automation"
cp -a reco-engine/server.py reco-engine/server.py.bak-$(date +%Y%m%d-%H%M%S)   # BACKUP
# ... make the 5 additive edits ...
python3 -m py_compile reco-engine/server.py && echo PY_OK                       # compile-check
# restart LOCAL engine (port 8765) only — see SERVERS.md for the exact command
# restart LOCAL backend (port 8001) only if you changed it (you shouldn't need to)
```

## 7. Verify (per patched agent)
1. Run the agent in the UI (localhost:3000) → confirm results render as before (no logic drift).
2. Click **Download Excel** → file downloads, opens, sheets/Remarks correct.
3. **Restart the engine**, then click **Download** again on the SAME run → must still download (served from `reco-engine/exports/<id>.xlsx`) → **no 404**. This is the whole point.
4. `ls -la reco-engine/exports/` → one `<job_id>.xlsx` per run.

## 8. Optional Phase 2 (only if asked — heavier, NOT required for §1)
"Persist the whole run so it can be **re-opened** (table + status) after a restart", not just the download:
- `GET /api/jobs/<id>` status/results (server.py ~line 143) is `JOBS.get(job_id)` with **no disk fallback** → 404s after restart / on a second engine.
- Would require persisting the results JSON to disk and adding a disk fallback there. Larger, and results JSON can be big — do only if explicitly requested. Phase 1 (§3) is the fast, safe, high-value win.

---
_Owner note: created 2026-08-07 while extending the AWS download-fix pattern to all local agents. The AWS box already runs the §2 pattern (deployed) + a 2-process engine pool; this doc is about LOCAL parity for the remaining 5 types._
