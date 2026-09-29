from __future__ import annotations

import logging
logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s: %(message)s")

from email.parser import BytesParser
from email.policy import default
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import re
import threading
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from openpyxl import Workbook
from openpyxl.styles import (
    Font, PatternFill, Alignment, Border, Side, numbers as xl_numbers
)
from openpyxl.formatting.rule import CellIsRule, FormulaRule

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from recon.core import MatchResult, reconcile, summarize
from recon.gstr_2a_2b_books import read_three_way_uploads, reconcile_three_way, summarize_three_way
from recon.gstr_3b_vs_2b import read_3b_2b_uploads, reconcile_3b_vs_2b, summarize_3b_vs_2b, build_month_pivot
from recon.gstr_1_vs_books import (
    read_octa_excel, read_tally_sales_raw, read_credit_note_raw,
    parse_gstr1_pdf_monthly,
    extract_gstr3b_monthly, aggregate_gstr1_monthly, aggregate_books_monthly,
    build_monthly_comparison, reconcile_b2b_new, reconcile_b2c_new,
    df_to_records, build_summary,
)
from recon.parsers import read_upload, read_excel_rows, normalize_rows
from recon.bank_reco import process_bank_statement
from recon.gstr_2b_books import reconcile_gstr2b_vs_books
from recon.gstr_2b_books_multistate import (
    reconcile_gstr2b_vs_books_multistate,
    build_gstr2b_books_multistate_workbook,
)
from recon.gstr_3b_tally_entry import (
    parse_gstr3b,
    build_tally_entries,
    build_gstr3b_tally_workbook,
    process_multi as gstr3b_process_multi,
    _load_coa,
    _load_coa_from_list,
    _load_voucher_types,
    _load_voucher_types_from_list,
)


# Directory where pre-built export workbooks are persisted to disk so that a
# reco-engine restart cannot lose an already-run job's download (in-memory JOBS
# is wiped on restart). Best-effort only: any disk error is swallowed and the
# in-memory fast path is unaffected. Override via RECO_OUTPUT_DIR env var.
RECO_OUTPUT_DIR = os.environ.get("RECO_OUTPUT_DIR") or str(ROOT / "exports")
# How many finished jobs stay in memory. Each carries its source workbooks as base64
# plus the built xlsx, so an unbounded dict was holding a working day's uploads. The
# xlsx is on disk regardless, so an evicted job still downloads.
_JOB_RETAIN = int(os.environ.get("RECO_JOB_RETAIN") or 20)
try:
    os.makedirs(RECO_OUTPUT_DIR, exist_ok=True)
except Exception:
    RECO_OUTPUT_DIR = ""


def _export_path(job_id: str) -> str:
    return os.path.join(RECO_OUTPUT_DIR, f"{job_id}.xlsx") if RECO_OUTPUT_DIR else ""


def _purge_old_exports(max_age_days: int = 3) -> None:
    """Delete persisted export files older than max_age_days (best-effort)."""
    if not RECO_OUTPUT_DIR:
        return
    try:
        import time
        cutoff = time.time() - max_age_days * 86400
        for name in os.listdir(RECO_OUTPUT_DIR):
            if not name.endswith(".xlsx"):
                continue
            fp = os.path.join(RECO_OUTPUT_DIR, name)
            try:
                if os.path.getmtime(fp) < cutoff:
                    os.remove(fp)
            except Exception:
                pass
    except Exception:
        pass


class _JobStore(dict):
    """dict that also persists a job's pre-built xlsx bytes to disk on assign.

    Every existing ``JOBS[job_id] = payload`` transparently writes the workbook
    to ``RECO_OUTPUT_DIR/<job_id>.xlsx`` when ``_xlsx_bytes`` is present, so the
    download survives an engine restart. Purely additive and best-effort: any
    failure is ignored and never affects the in-memory reconciliation path.
    """

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        try:
            if RECO_OUTPUT_DIR and isinstance(value, dict) and value.get("_xlsx_bytes"):
                path = _export_path(key)
                if path and not os.path.exists(path):
                    tmp = path + ".part"
                    with open(tmp, "wb") as f:
                        f.write(value["_xlsx_bytes"])
                    os.replace(tmp, path)
        except Exception:
            pass
        # Keep only the most recent jobs in memory. A payload holds the source
        # workbooks as base64 plus the built xlsx and the parsed result objects —
        # tens of MB each — and this dict only ever grew, so a day's work sat in RAM
        # long after anyone cared.
        #
        # Eviction is disk-aware on purpose. Not every reco type pre-builds
        # ``_xlsx_bytes`` (multi-state builds its workbook lazily in export_job), so
        # those jobs have no file yet and dropping one would 404 its download. So:
        # evict a job whose workbook IS on disk first — that costs nothing, export_job
        # reads the file. Only when nothing is on disk, and only once we are well past
        # the limit, drop the oldest anyway, which still leaves a long window for the
        # first download to rebuild and persist it.
        try:
            while len(self) > _JOB_RETAIN:
                victim = None
                for candidate in self:
                    if candidate == key:
                        continue
                    path = _export_path(candidate)
                    if path and os.path.exists(path):
                        victim = candidate
                        break
                if victim is None:
                    if len(self) <= _JOB_RETAIN * 2:
                        break
                    victim = next(iter(self))
                    if victim == key:
                        break
                super().pop(victim, None)
        except Exception:
            pass


JOBS: dict[str, dict] = _JobStore()


def _card_rows_for_ui(working_rows: list[dict]) -> list[dict]:
    """Serialise Credit Card Booking rows for the review grid.

    Dates become ISO strings (JSON has no date type) and only the fields the UI
    needs are sent — the workbook is fetched separately via the export endpoint,
    so the whole statement is not duplicated into this response.
    """
    out = []
    for i, w in enumerate(working_rows):
        d = w.get("date")
        out.append({
            "row":         i,
            "date":        d.isoformat() if hasattr(d, "isoformat") else (d or ""),
            "narration":   w.get("narration") or "",
            "category":    w.get("category") or "",
            "debit":       w.get("debit") or "",
            "credit":      w.get("credit") or "",
            "amount":      w.get("amount"),
            "voucher_type": w.get("voucher_type") or "",
            "layer":       w.get("layer") or "",
            "confidence":  w.get("confidence") or "",
            "is_suspense": bool(w.get("is_suspense")),
            "no_amount":   bool(w.get("no_amount")),
        })
    return out

# Limit simultaneous reconciliation jobs to prevent OOM under heavy load.
# Each job can hold large DataFrames in memory; 8 concurrent runs is safe
# for a server with 8+ GB RAM. Override via MAX_CONCURRENT_RECO env var.
_MAX_RECO = int(os.environ.get("MAX_CONCURRENT_RECO", "8"))
_RECO_SEMAPHORE = threading.Semaphore(_MAX_RECO)


def _prep_gstr2b_layouts(gstr2b_files: list, fields: dict) -> None:
    """Before a 2B run: forget each file's cached layout (so this run's AI use and
    confirm status are reported fresh), then save the accountant's corrected columns
    — sent as gstr2bColumnOverride after they said a new layout's output was wrong."""
    from recon.gstr_2b_books import forget_gstr2b_format, _ensure_xlsx
    from recon.gstr2b_formats import apply_override
    override = None
    raw = fields.get("gstr2bColumnOverride") or ""
    if raw:
        try:
            override = json.loads(raw)
        except Exception:
            override = None
    for blob in gstr2b_files:
        if not blob:
            continue
        data = _ensure_xlsx(blob)
        forget_gstr2b_format(data)
        if override:
            apply_override(data, override)


def _gstr2b_formats_for(named_files: list) -> list:
    """[{file, format, ...}] — the layout each 2B file was read as (never calls the API)."""
    from recon.gstr_2b_books import gstr2b_format_info
    out = []
    for name, blob in named_files:
        if not blob:
            continue
        try:
            out.append({"file": name, **gstr2b_format_info(blob)})
        except Exception:
            out.append({"file": name, "format": "unknown"})
    return out


class ReconciliationHandler(BaseHTTPRequestHandler):
    server_version = "CARecon/0.1"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            self.serve_static("index.html")
            return
        if path.startswith("/static/"):
            self.serve_static(path.removeprefix("/static/"))
            return
        if path.startswith("/api/jobs/") and path.endswith("/export.xlsx"):
            job_id = path.split("/")[3]
            self.export_job(job_id)
            return
        if path.startswith("/api/jobs/"):
            job_id = path.split("/")[3]
            self.write_json(JOBS.get(job_id) or {"error": "Job not found"}, 200 if job_id in JOBS else 404)
            return
        self.write_json({"error": "Not found"}, 404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/einvoice/parse":
            self.handle_einvoice_parse()
            return
        if parsed.path == "/api/einvoice/build":
            self.handle_einvoice_build()
            return
        if parsed.path == "/api/purchase-invoice/extract":
            self.handle_purchase_extract()
            return
        if parsed.path == "/api/purchase-invoice/build":
            self.handle_purchase_build()
            return
        if parsed.path == "/api/x2beta/build":
            self.handle_x2beta_build()
            return
        if parsed.path == "/api/gstr2b-format/confirm":
            self.handle_gstr2b_format_confirm()
            return
        if parsed.path != "/api/reconcile":
            self.write_json({"error": "Not found"}, 404)
            return
        # Reject immediately if the server is at capacity — avoids OOM
        if not _RECO_SEMAPHORE.acquire(blocking=False):
            self.write_json(
                {"error": "Server busy. Too many reconciliations running. Retry in 30 seconds."},
                503,
            )
            return
        try:
            fields, files = self.read_multipart()
            tolerance = float(fields.get("tolerance", "1") or 1)
            reco_type = fields.get("reco_type", "gst_2b_purchase")

            if reco_type == "gstr_3b_vs_2b":
                gstr2b_records, gstr3b_records = read_3b_2b_uploads(files)
                results = reconcile_3b_vs_2b(gstr2b_records, gstr3b_records, tolerance=tolerance)
                pivot = build_month_pivot(results)
                job_id = uuid4().hex
                payload = {
                    "job_id": job_id,
                    "reco_type": reco_type,
                    "summary": summarize_3b_vs_2b(results),
                    "pivot": pivot,
                    "counts": {
                        "gstr2b_records": len(gstr2b_records),
                        "gstr3b_records": len(gstr3b_records),
                        "result_rows": len(results),
                    },
                    "results": [result.as_dict() for result in results],
                }
                JOBS[job_id] = payload
                self.write_json(payload)
                return

            if reco_type == "gstr_2a_2b_books":
                gstr2a_records, gstr2b_records, books_records = read_three_way_uploads(files)
                results = reconcile_three_way(gstr2a_records, gstr2b_records, books_records, tolerance=tolerance)
                job_id = uuid4().hex
                payload = {
                    "job_id": job_id,
                    "reco_type": reco_type,
                    "summary": summarize_three_way(results),
                    "counts": {
                        "gstr2a_records": len(gstr2a_records),
                        "gstr2b_records": len(gstr2b_records),
                        "books_records": len(books_records),
                        "result_rows": len(results),
                    },
                    "results": [result.as_dict() for result in results],
                }
                JOBS[job_id] = payload
                self.write_json(payload)
                return

            # GSTR-3B vs Books — its own agent (all states, all months).
            if reco_type == "gstr_3b_vs_books":
                _handle_gstr3b_vs_books(self, fields, files, tolerance)
                return

            # Combined / multi-state / multi-month GSTR-1 — additive, see
            # _handle_gstr1_multistate. The single-file branch below is unchanged.
            if reco_type == "gstr_1_vs_books" and _gstr1_multistate_requested(fields, files):
                _handle_gstr1_multistate(self, fields, files, tolerance)
                return

            if reco_type == "gstr_1_vs_books":
                octa_file   = files.get("gstr1_octa") or files.get("gstr1")
                tally_file  = files.get("tally_sales")
                pdf_file    = files.get("gstr1_pdf")
                cn_file     = files.get("credit_note")
                if not octa_file:
                    self.write_json({"error": "Upload the GSTR-1 OCTA Report file (gstr1_octa)."}, 400)
                    return
                if not tally_file:
                    self.write_json({"error": "Upload the Tally Sales Register file (tally_sales)."}, 400)
                    return

                # Read inputs
                gstr1_df, gstr3b_df, gstr2b_df = read_octa_excel(octa_file)
                tally_df = read_tally_sales_raw(tally_file)
                cn_df = read_credit_note_raw(cn_file) if cn_file else None
                # A separate Credit Note Register has to net off sales, otherwise Books
                # stays overstated and every GSTR-1 credit note reads "Not in Books".
                # The passthrough sheets below still show both files exactly as uploaded.
                from recon.gstr_1_vs_books import merge_credit_notes
                reco_df = merge_credit_notes(tally_df, cn_df)

                # Step 0 (optional): GSTR-1 Pivot
                pdf_monthly = None
                if pdf_file and pdf_file.get("content"):
                    pdf_monthly = parse_gstr1_pdf_monthly(pdf_file["content"])

                # Steps 1–4: monthly comparison sections
                gstr1_monthly   = aggregate_gstr1_monthly(gstr1_df)
                gstr3b_monthly  = extract_gstr3b_monthly(gstr3b_df)
                from recon.gstr_1_vs_books import _gstr1_b2b_invoice_set
                _g1_b2b_invs    = _gstr1_b2b_invoice_set(gstr1_df)
                books_all       = aggregate_books_monthly(reco_df)
                books_b2b       = aggregate_books_monthly(reco_df, category="B2B", g1_b2b_invs=_g1_b2b_invs)
                books_b2c       = aggregate_books_monthly(reco_df, category="B2C", g1_b2b_invs=_g1_b2b_invs)

                # Filter GSTR-1 B2B/B2C monthly totals
                import re as _re
                gstr1_b2b_monthly = {}
                gstr1_b2c_monthly = {}
                if not gstr1_df.empty:
                    from recon.gstr_1_vs_books import _find_col, _f, _norm_month, _FY_MONTHS, _zero_amounts, _add_amounts
                    from recon.gstr_1_vs_books import gstr1_month_basis
                    # Same month basis as Section 2, so all three sections agree
                    _month_of, _ = gstr1_month_basis(gstr1_df)
                    gstin_col   = _find_col(gstr1_df, ["Customer GSTIN", "GSTIN of Recipient"])
                    taxable_col = _find_col(gstr1_df, ["Item Taxable Value", "Taxable Value"])
                    igst_col    = _find_col(gstr1_df, ["IGST", "Integrated Tax"])
                    cgst_col    = _find_col(gstr1_df, ["CGST", "Central Tax"])
                    sgst_col    = _find_col(gstr1_df, ["SGST", "State Tax"])
                    from collections import defaultdict as _dd
                    _b2b = _dd(_zero_amounts)
                    _b2c = _dd(_zero_amounts)
                    for _, row in gstr1_df.iterrows():
                        from recon.gstr_1_vs_books import _col_val
                        month = _month_of(row)
                        if month not in _FY_MONTHS:
                            continue
                        gstin = str(_col_val(row, gstin_col, "")).strip()
                        is_b2b = bool(gstin) and len(_re.sub(r"[^A-Z0-9]","",gstin.upper())) == 15
                        bucket = _b2b[month] if is_b2b else _b2c[month]
                        _add_amounts(bucket,
                            taxable=_f(_col_val(row, taxable_col, 0)),
                            igst=_f(_col_val(row, igst_col, 0)),
                            cgst=_f(_col_val(row, cgst_col, 0)),
                            sgst=_f(_col_val(row, sgst_col, 0)))
                    gstr1_b2b_monthly = dict(_b2b)
                    gstr1_b2c_monthly = dict(_b2c)

                gst_reco_sections = {
                    "gstr1_vs_gstr3b":    build_monthly_comparison(gstr1_monthly,  gstr3b_monthly,  "gstr1", "gstr3b"),
                    "books_all_vs_gstr1": build_monthly_comparison(books_all,       gstr1_monthly,   "books", "gstr1"),
                    "books_b2b_vs_gstr1": build_monthly_comparison(books_b2b,       gstr1_b2b_monthly, "books", "gstr1"),
                    "books_b2c_vs_gstr1": build_monthly_comparison(books_b2c,       gstr1_b2c_monthly, "books", "gstr1"),
                }

                # Step 5: B2B Reco
                b2b_rows = reconcile_b2b_new(reco_df, gstr1_df, tolerance)

                # Step 6: B2C Reco
                b2c_rows = reconcile_b2c_new(reco_df, gstr1_df, tolerance)

                # GSTR-1 Pivot (Step 0)
                pivot_rows = None
                if pdf_monthly and gstr1_monthly:
                    pivot_rows = build_monthly_comparison(gstr1_monthly, pdf_monthly, "excel", "pdf")

                # Slim b2b rows for UI display (key fields only — avoids sending 52-col Tally data)
                from recon.gstr_1_vs_books import _find_col as _fc2
                _inv_k  = _fc2(tally_df, ["Voucher No.", "Voucher No", "Invoice No", "Doc No", "Bill No"])
                _date_k = _fc2(tally_df, ["Date", "Invoice Date", "Voucher Date"])
                _part_k = _fc2(tally_df, ["Particulars", "Party Name", "Buyer", "Ledger Name"])
                _gst_k  = _fc2(tally_df, ["GSTIN", "GSTIN/UIN", "Buyer GSTIN"])
                _tax_k  = _fc2(tally_df, ["Total Sales", "Taxable Value", "Taxable Amount"])
                _igst_k = _fc2(tally_df, ["Total IGST", "IGST"])
                _cgst_k = _fc2(tally_df, ["Total CGST", "CGST"])
                _sgst_k = _fc2(tally_df, ["Total SGST", "SGST"])
                b2b_ui_rows = [{
                    "date":         _r.get(_date_k),
                    "inv_no":       _r.get(_inv_k),
                    "party":        _r.get(_part_k),
                    "gstin":        _r.get(_gst_k),
                    "t_taxable":    _r.get(_tax_k, 0),
                    "t_igst":       _r.get(_igst_k, 0),
                    "t_cgst":       _r.get(_cgst_k, 0),
                    "t_sgst":       _r.get(_sgst_k, 0),
                    "g1_inv":       _r.get("_gstr1_inv_no"),
                    "g1_taxable":   _r.get("_gstr1_taxable", 0),
                    "g1_igst":      _r.get("_gstr1_igst", 0),
                    "g1_cgst":      _r.get("_gstr1_cgst", 0),
                    "g1_sgst":      _r.get("_gstr1_sgst", 0),
                    "diff_taxable": _r.get("_diff_taxable", 0),
                    "diff_igst":    _r.get("_diff_igst", 0),
                    "diff_cgst":    _r.get("_diff_cgst", 0),
                    "diff_sgst":    _r.get("_diff_sgst", 0),
                    "remark":       _r.get("_remark"),
                } for _r in b2b_rows]

                import base64
                from io import BytesIO as _BytesIO
                job_id = uuid4().hex
                payload = {
                    "job_id": job_id,
                    "reco_type": reco_type,
                    "summary": build_summary(b2b_rows, b2c_rows),
                    "counts": {
                        "tally_rows":    len(tally_df),
                        "gstr1_rows":    len(gstr1_df),
                        "b2b_reco_rows": len(b2b_rows),
                        "b2c_reco_rows": len(b2c_rows),
                        "total_records": len(b2b_rows) + len(b2c_rows),
                    },
                    "results": [],  # not used by frontend for this agent
                    # Private: reco data used by workbook builder
                    "_gst_reco_sections": gst_reco_sections,
                    "_b2b_reco_rows": b2b_rows,
                    "_b2c_reco_rows": b2c_rows,
                    "_pivot_rows": pivot_rows,
                    "_tally_cols": list(tally_df.columns),
                    # Some OCTA exports are GSTR-1 only — flag it instead of
                    # comparing GSTR-1 against a column of zeros.
                    "_gstr3b_available": not gstr3b_df.empty,
                    # Raw DataFrames as records for passthrough sheets
                    "_raw_gstr1":  df_to_records(gstr1_df),
                    "_raw_gstr2b": df_to_records(gstr2b_df),
                    "_raw_gstr3b": df_to_records(gstr3b_df),
                    "_raw_tally":  df_to_records(tally_df),
                    "_raw_cn":     df_to_records(cn_df) if cn_df is not None else None,
                }
                # Pre-build workbook now (during upload) so download is instant
                try:
                    _wb = build_gstr1_workbook(
                        [], monthly_summary=[], summary=payload["summary"],
                        counts=payload["counts"], payload=payload,
                    )
                    _buf = _BytesIO()
                    _wb.save(_buf)
                    payload["_xlsx_bytes"] = _buf.getvalue()
                except Exception as _e:
                    import logging as _log
                    _log.getLogger(__name__).error("Pre-build workbook failed: %s", _e)
                    payload["_xlsx_bytes"] = None
                JOBS[job_id] = payload
                # Return only public fields to frontend (plus UI display data)
                public = {k: v for k, v in payload.items() if not k.startswith("_")}
                public["gst_reco_sections"] = gst_reco_sections
                public["b2b_ui_rows"] = b2b_ui_rows
                public["b2c_rows"] = b2c_rows
                self.write_json(public)
                return

            if reco_type == "bank_reco":
                bank_file = files.get("bank_statement")
                if not bank_file:
                    self.write_json({"error": "Upload Bank Statement file."}, 400)
                    return
                
                payload = process_bank_statement(bank_file["content"])
                # Pre-build workbook so Download is instant AND survives an engine
                # restart (_JobStore persists _xlsx_bytes to disk). Best-effort:
                # on failure export_job rebuilds on demand — zero regression.
                try:
                    from io import BytesIO as _BytesIO
                    _wb = build_workbook(
                        payload["results"], payload["summary"], payload["counts"],
                        reco_type,
                    )
                    _buf = _BytesIO(); _wb.save(_buf)
                    payload["_xlsx_bytes"] = _buf.getvalue()
                except Exception as _e:
                    _log.getLogger(__name__).error("Pre-build bank_reco workbook failed: %s", _e)
                    payload["_xlsx_bytes"] = None
                JOBS[payload["job_id"]] = payload
                # Internal keys never leave the engine. They are the source workbooks held as
                # base64 (plus the parsed result objects): tens of MB that the browser has no
                # use for, but which were serialised here, buffered whole by axios in the
                # backend (maxContentLength: Infinity) and forwarded on — the main reason the
                # backend ballooned to GBs and stalled during a large reconciliation. They stay
                # in JOBS for the download, so nothing is lost. The e-invoice branch already
                # filtered this way; these two did not.
                self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
                return

            # GSTR-2B vs Books (Purchase Register + Debit Note Register)
            if reco_type == "gstr_2b_books":
                gstr2b_file = files.get("gstr2b")
                purchase_file = files.get("purchase")
                debit_file = files.get("debit")
                if not gstr2b_file or not purchase_file or not debit_file:
                    self.write_json({"error": "Upload GSTR-2B, Purchase Register, and Debit Note Register files."}, 400)
                    return
                from recon.gstr_2b_books import _ensure_xlsx
                gstr2b_bytes = _ensure_xlsx(gstr2b_file["content"])
                purchase_bytes = _ensure_xlsx(purchase_file["content"])
                debit_bytes = _ensure_xlsx(debit_file["content"])
                proceed_without_names = str(fields.get("proceedWithoutNames", "")).strip().lower() in ("1", "true", "yes")
                try:
                    name_corrections = json.loads(fields.get("nameCorrections", "") or "{}")
                except Exception:
                    name_corrections = {}
                # GSTR-2B layout: forget what this process last knew about the file, and
                # save the accountant's corrected columns (new layouts only) before reading.
                _prep_gstr2b_layouts([gstr2b_bytes], fields)
                gstr2b_records, books_records, results, missing_names = reconcile_gstr2b_vs_books(
                    gstr2b_bytes,
                    purchase_bytes,
                    debit_bytes,
                    tolerance=tolerance,
                    name_corrections=name_corrections,
                )
                # The portal export leaves Trade/Legal Name blank for every row but
                # the first in a supplier's block (see gstr_2b_books.py). Surface
                # those suppliers so the user can confirm/enter the name — or
                # explicitly proceed and leave it blank — instead of silently
                # inheriting it from the row above.
                if missing_names and not proceed_without_names:
                    self.write_json({
                        "error": "Some suppliers in the GSTR-2B file are missing a Trade/Legal Name.",
                        "missingTradeLegalNames": missing_names,
                    }, 400)
                    return
                job_id = uuid4().hex
                import base64
                payload = {
                    "job_id": job_id,
                    "reco_type": reco_type,
                    "summary": summarize(results),
                    "counts": {
                        "gstr2b_records": len(gstr2b_records),
                        "books_records": len(books_records),
                        "result_rows": len(results),
                    },
                    "results": [result.as_dict() for result in results],
                    # Which layout the 2B was read as; a 'new' one asks the accountant
                    # to confirm the output before its column mapping is kept.
                    "gstr2b_formats": _gstr2b_formats_for([(gstr2b_file.get("filename", ""), gstr2b_bytes)]),
                    "_gstr2b_b64": base64.b64encode(gstr2b_bytes).decode("utf-8"),
                    "_purchase_b64": base64.b64encode(purchase_bytes).decode("utf-8"),
                    "_debit_b64": base64.b64encode(debit_bytes).decode("utf-8"),
                }
                # Pre-build the workbook now (during the run) so the download is
                # instant AND survives an engine restart — the _JobStore persists
                # _xlsx_bytes to disk. Best-effort: on failure we fall back to the
                # on-demand rebuild path in export_job (unchanged behavior).
                try:
                    from io import BytesIO as _BytesIO
                    _wb = build_workbook(
                        payload["results"], payload["summary"], payload["counts"],
                        reco_type, pivot=payload.get("pivot"), payload=payload,
                    )
                    _buf = _BytesIO()
                    _wb.save(_buf)
                    payload["_xlsx_bytes"] = _buf.getvalue()
                except Exception as _e:
                    import logging as _log
                    _log.getLogger(__name__).error("Pre-build gstr_2b_books workbook failed: %s", _e)
                    payload["_xlsx_bytes"] = None
                JOBS[job_id] = payload
                # Exclude only the raw xlsx bytes from the JSON response (they are
                # cached in JOBS/disk for download); response shape is otherwise
                # identical to before.
                # Internal keys never leave the engine. They are the source workbooks held as
                # base64 (plus the parsed result objects): tens of MB that the browser has no
                # use for, but which were serialised here, buffered whole by axios in the
                # backend (maxContentLength: Infinity) and forwarded on — the main reason the
                # backend ballooned to GBs and stalled during a large reconciliation. They stay
                # in JOBS for the download, so nothing is lost. The e-invoice branch already
                # filtered this way; these two did not.
                self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
                return

            # GSTR-2B vs Books — Multi-State (N files per input type)
            if reco_type == "gstr_2b_books_multistate":
                def _file_list(name):
                    """Normalise single dict or list-of-dicts into list of content bytes."""
                    val = files.get(name)
                    if val is None:
                        return []
                    items = val if isinstance(val, list) else [val]
                    return [item["content"] for item in items if item.get("content")]

                def _file_items(name):
                    """Return raw list of file dicts (keeps filename alongside content)."""
                    val = files.get(name)
                    if val is None:
                        return []
                    items = val if isinstance(val, list) else [val]
                    return [item for item in items if item.get("content")]

                _GSTIN_IN_FILENAME = re.compile(
                    r'[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]',
                    re.IGNORECASE,
                )

                def _entity_gstin_from_filename(fn: str) -> str:
                    """Extract entity GSTIN from GSTN portal filename (e.g. 102024_29AAECF7751Q1ZS_GSTR2B_...)."""
                    m = _GSTIN_IN_FILENAME.search(fn.upper())
                    return m.group(0).upper() if m else ""

                gstr2b_items  = _file_items("gstr2b")
                gstr2b_list   = [it["content"] for it in gstr2b_items]
                entity_gstins = [_entity_gstin_from_filename(it.get("filename", "")) for it in gstr2b_items]
                # A file whose name carries no GSTIN (e.g. the Combined workbook) may state
                # it in its title — '... (GSTIN 27AAQCM9664F1ZS)'. Filename still wins.
                from recon.gstr2b_formats import entity_gstin_from_workbook
                from recon.gstr_2b_books import _ensure_xlsx as _xlsx_2b
                entity_gstins = [g or entity_gstin_from_workbook(_xlsx_2b(it["content"]))
                                 for g, it in zip(entity_gstins, gstr2b_items)]

                purchase_list = _file_list("purchase")
                debit_list    = _file_list("debit")

                if not gstr2b_list or not purchase_list:
                    self.write_json({"error": "Upload at least one GSTR-2B and one Purchase Register file."}, 400)
                    return

                # "Combined books" — one Purchase/Debit register covering every state,
                # rather than one per state. GSTR-2B stays per state either way.
                books_combined = str(fields.get("books_combined", "")).strip().lower() in ("1", "true", "yes")

                # Same missing-name flow as the single-state engine above: the UI
                # sends nameCorrections {GSTIN: name} on re-run, or proceedWithoutNames.
                proceed_without_names = str(fields.get("proceedWithoutNames", "")).strip().lower() in ("1", "true", "yes")
                try:
                    name_corrections = json.loads(fields.get("nameCorrections", "") or "{}")
                except Exception:
                    name_corrections = {}
                _prep_gstr2b_layouts(gstr2b_list, fields)
                gstr2b_recs, books_recs, results, missing_names = reconcile_gstr2b_vs_books_multistate(
                    gstr2b_list, purchase_list, debit_list or [b""] * len(purchase_list),
                    tolerance=tolerance,
                    entity_gstins=entity_gstins,
                    books_combined=books_combined,
                    name_corrections=name_corrections,
                    return_missing=True,
                )
                if missing_names and not proceed_without_names:
                    self.write_json({
                        "error": "Some suppliers in the GSTR-2B file are missing a Trade/Legal Name.",
                        "missingTradeLegalNames": missing_names,
                    }, 400)
                    return

                # The workbook copies a source sheet per Books file. A combined register
                # submitted once per state slot would be copied in that many times, so
                # the PR sheet repeated the whole register. Keep only distinct content.
                def _distinct(blobs):
                    seen, out = set(), []
                    for blob in blobs:
                        if not blob:
                            continue
                        digest = hashlib.sha256(blob).hexdigest()
                        if digest not in seen:
                            seen.add(digest)
                            out.append(blob)
                    return out

                purchase_sheets = _distinct(purchase_list)
                debit_sheets    = _distinct(debit_list)

                import base64
                job_id  = uuid4().hex
                # Encode each distinct file ONCE. The per-state lists and the "state 1"
                # keys below then share the very same string objects instead of holding
                # a second, identical copy — a 10 MB register was being base64'd twice
                # into one payload, 13 MB kept needlessly each time.
                _all_g = [base64.b64encode(f).decode("utf-8") for f in gstr2b_list]
                _all_p = [base64.b64encode(f).decode("utf-8") for f in purchase_sheets]
                _all_d = [base64.b64encode(f).decode("utf-8") for f in debit_sheets]
                payload = {
                    "job_id":    job_id,
                    "reco_type": reco_type,
                    "summary":   summarize(results),
                    "counts": {
                        "gstr2b_records": len(gstr2b_recs),
                        "books_records":  len(books_recs),
                        "result_rows":    len(results),
                        "file_count":     len(gstr2b_list),
                    },
                    "results": [result.as_dict() for result in results],
                    "gstr2b_formats": _gstr2b_formats_for(
                        [(it.get("filename", ""), it["content"]) for it in gstr2b_items]),
                    # First file of each type (for base workbook source sheets — state 1);
                    # the SAME object as element 0 of the list below, not a re-encode.
                    "_gstr2b_b64":   _all_g[0] if _all_g else "",
                    "_purchase_b64": _all_p[0] if _all_p else "",
                    "_debit_b64":    _all_d[0] if _all_d else "",
                    # All state files (for adding per-state source sheets to the workbook)
                    "_all_gstr2b_b64":   _all_g,
                    "_all_purchase_b64": _all_p,
                    "_all_debit_b64":    _all_d,
                    # Stash MatchResult objects so export_job can rebuild Remark 3
                    "_results_obj":  results,
                }
                # Pre-build the (heavy) multi-state workbook now so the download is
                # instant and survives an engine restart (persisted to disk via the
                # _JobStore). Best-effort: on failure export_job rebuilds on demand.
                try:
                    from io import BytesIO as _BytesIO
                    _wb = build_workbook(
                        payload["results"], payload["summary"], payload["counts"],
                        reco_type, pivot=payload.get("pivot"), payload=payload,
                    )
                    _buf = _BytesIO()
                    _wb.save(_buf)
                    payload["_xlsx_bytes"] = _buf.getvalue()
                except Exception as _e:
                    import logging as _log
                    _log.getLogger(__name__).error("Pre-build multistate workbook failed: %s", _e)
                    payload["_xlsx_bytes"] = None
                JOBS[job_id] = payload
                self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
                return

            # E-Invoice Reco — GST Portal E-Invoice Register vs Books (Sales + Credit Note)
            if reco_type == "einvoice_reco":
                einvoice_file = files.get("einvoice")
                books_file = files.get("books")
                if not einvoice_file or not books_file:
                    self.write_json({"error": "Upload the E-Invoice Register and the Books (Sales + Credit Note) file."}, 400)
                    return
                from recon.einvoice_reco import reconcile_einvoice_top
                import base64
                einv_bytes = einvoice_file["content"]
                books_bytes = books_file["content"]
                bundle = reconcile_einvoice_top(einv_bytes, books_bytes, tolerance=tolerance)
                results = bundle["results"]
                job_id = uuid4().hex
                payload = {
                    "job_id": job_id,
                    "reco_type": reco_type,
                    "summary": summarize(results),
                    "counts": {
                        "einvoice_records": len(bundle["einv_pivot"]),
                        "books_records": len(bundle["books_pivot"]),
                        "result_rows": len(results),
                    },
                    "results": [result.as_dict() for result in results],
                    "_bundle": bundle,
                    "_einvoice_b64": base64.b64encode(einv_bytes).decode("utf-8"),
                    "_books_b64": base64.b64encode(books_bytes).decode("utf-8"),
                }
                JOBS[job_id] = payload
                self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
                return

            if reco_type == "gstr_3b_tally_entry":
                # Accept 1–15 gstr3b files (repeated field name) + optional coa file
                def _gstr3b_file_items(name):
                    val = files.get(name)
                    if val is None:
                        return []
                    items = val if isinstance(val, list) else [val]
                    return [item for item in items if item.get("content")]

                gstr3b_files = _gstr3b_file_items("gstr3b")
                if not gstr3b_files:
                    self.write_json({"error": "Upload at least one GSTR-3B file."}, 400)
                    return

                coa_file = files.get("coa")
                if isinstance(coa_file, list):
                    coa_file = coa_file[0]

                vt_file = files.get("vouchertype")
                if isinstance(vt_file, list):
                    vt_file = vt_file[0]

                # COA resolution: uploaded file → DB JSON list → None
                if coa_file:
                    coa = _load_coa(coa_file["content"], coa_file["filename"])
                    coa_parsed_list = list(coa.values())
                elif fields.get("coa_ledgers"):
                    try:
                        coa = _load_coa_from_list(json.loads(fields["coa_ledgers"]))
                    except Exception:
                        coa = None
                    coa_parsed_list = []
                else:
                    coa = None
                    coa_parsed_list = []

                # Voucher Type resolution: uploaded file → DB JSON list → None
                if vt_file:
                    vt_master = _load_voucher_types(vt_file["content"], vt_file["filename"])
                    vt_parsed_list = list(vt_master.values())
                elif fields.get("vt_ledgers"):
                    try:
                        vt_master = _load_voucher_types_from_list(json.loads(fields["vt_ledgers"]))
                    except Exception:
                        vt_master = None
                    vt_parsed_list = []
                else:
                    vt_master = None
                    vt_parsed_list = []

                all_entries, monthly_data, state_summary = gstr3b_process_multi(
                    gstr3b_files, coa=coa, vt_master=vt_master
                )
                job_id = uuid4().hex
                payload = {
                    "job_id": job_id,
                    "reco_type": reco_type,
                    "monthly_data": monthly_data,
                    "state_summary": state_summary,
                    "coa_ledgers_parsed": coa_parsed_list,
                    "vt_ledgers_parsed": vt_parsed_list,
                    "summary": {
                        "months": len(monthly_data),
                        "gstin":  monthly_data[0]["gstin"]  if monthly_data else "",
                        "state":  monthly_data[0]["state"]  if monthly_data else "",
                        "period": monthly_data[0]["period"] if monthly_data else "",
                    },
                    "counts": {"entry_rows": len(all_entries), "months": len(monthly_data)},
                    "results": all_entries,
                    "_monthly_data":   monthly_data,
                    "_state_summary":  state_summary,
                }
                # Pre-build workbook so Download is instant AND survives an engine
                # restart (_JobStore persists _xlsx_bytes to disk). Best-effort:
                # on failure export_job rebuilds on demand — zero regression.
                try:
                    from io import BytesIO as _BytesIO
                    _wb = build_workbook(
                        payload["results"], payload["summary"], payload["counts"],
                        reco_type, payload=payload,   # gstr_3b_tally reads _monthly_data/_state_summary from payload
                    )
                    _buf = _BytesIO(); _wb.save(_buf)
                    payload["_xlsx_bytes"] = _buf.getvalue()
                except Exception as _e:
                    _log.getLogger(__name__).error("Pre-build gstr_3b_tally_entry workbook failed: %s", _e)
                    payload["_xlsx_bytes"] = None
                JOBS[job_id] = payload
                self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
                return

            if reco_type == "pdf_bank_extract":
                from recon.pdf_bank_extractor import extract_bank_statement, build_pdf_bank_excel
                pdf_file = files.get("bank_pdf")
                if not pdf_file:
                    self.write_json({"error": "Upload a bank statement PDF (field name: bank_pdf)."}, 400)
                    return
                content = pdf_file["content"] if isinstance(pdf_file, dict) else pdf_file[0]["content"]
                pdf_password = (fields.get("pdf_password") or "").strip()
                data = extract_bank_statement(content, password=pdf_password)
                excel_bytes = build_pdf_bank_excel(data)
                job_id = uuid4().hex
                payload = {
                    "job_id":            job_id,
                    "reco_type":         reco_type,
                    "bank_name":         data.get("bank_name", ""),
                    "account_no":        data.get("account_no", ""),
                    "account_name":      data.get("account_name", ""),
                    "period_from":       data.get("period_from", ""),
                    "period_to":         data.get("period_to", ""),
                    "transaction_count": data.get("transaction_count", 0),
                    "validation":        data.get("validation", {}),
                    "preview_rows":      data.get("preview_rows", []),
                    "summary":           {"total": data.get("transaction_count", 0)},
                    "counts":            {"transaction_rows": data.get("transaction_count", 0)},
                    "results":           [],  # not used — download is via export endpoint
                    "_xlsx_bytes":       excel_bytes,
                }
                JOBS[job_id] = payload
                self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
                return

            if reco_type == "credit_card_booking":
                from recon.credit_card_booking import run as run_card_booking
                card_file = files.get("card_statement")
                if not card_file:
                    self.write_json({"error": "Upload a credit card statement PDF or Excel "
                                              "(field name: card_statement)."}, 400)
                    return
                if isinstance(card_file, dict):
                    content, fname = card_file["content"], card_file.get("filename", "")
                else:
                    content, fname = card_file[0]["content"], card_file[0].get("filename", "")

                # The chart of accounts and the learned merchant directory are read
                # from the brand's DB by Node (under RLS) and passed in as JSON —
                # this engine never touches the database, same as every other agent.
                def _json_field(name):
                    raw = (fields.get(name) or "").strip()
                    if not raw:
                        return []
                    try:
                        return json.loads(raw)
                    except Exception:
                        logging.warning("credit_card_booking: bad JSON in field %r", name)
                        return []

                data = run_card_booking(
                    content,
                    filename=fname,
                    password=(fields.get("pdf_password") or "").strip(),
                    coa=_json_field("coa"),
                    directory=_json_field("directory"),
                    card_ledger=(fields.get("card_ledger") or "").strip(),
                    voucher_type=(fields.get("voucher_type") or "").strip(),
                    use_llm=(fields.get("use_llm") or "1").strip() not in ("0", "false", "no"),
                )
                if data.get("error"):
                    self.write_json({"error": data["error"]}, 400)
                    return

                summary = data.get("summary") or {}
                job_id = uuid4().hex
                payload = {
                    "job_id":            job_id,
                    "reco_type":         reco_type,
                    "bank_name":         (data.get("meta") or {}).get("bank_name", ""),
                    "account_no":        (data.get("meta") or {}).get("account_no", ""),
                    "period":            (data.get("meta") or {}).get("period", ""),
                    "card_ledger":       (data.get("meta") or {}).get("card_ledger", ""),
                    "transaction_count": summary.get("extracted", 0),
                    "summary":           summary,
                    "verification":      data.get("verification") or {},
                    "blocked":           bool(data.get("blocked")),
                    "counts": {
                        "extracted":         summary.get("extracted", 0),
                        "booked":            summary.get("booked", 0),
                        "suspense":          summary.get("suspense", 0),
                        "zero_amount":       summary.get("zero_amount", 0),
                        "excluded_credits":  summary.get("excluded_credits", 0),
                        "excluded_payments": summary.get("excluded_payments", 0),
                    },
                    # Rows feed the review grid; the reviewer's corrections are what
                    # the learning loop consumes.
                    "results":           _card_rows_for_ui(data.get("working_rows") or []),
                    "learned_keys":      data.get("learned_keys") or [],
                    "_xlsx_bytes":       data.get("excel"),
                }
                JOBS[job_id] = payload
                self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
                return

            # Leisure Reco — generic two-party ledger reconciliation (any Internal
            # Ledger vs any Counterparty Statement export). Fully self-contained
            # engine (recon/leisure_reco.py) — does not share code with any other
            # reco agent, and deliberately makes no assumption about the client's
            # own chart-of-accounts columns beyond the fixed Tally ledger fields.
            if reco_type == "leisure_reco":
                internal_file = files.get("internal_ledger")
                counterparty_file = files.get("counterparty_ledger")
                if not internal_file or not counterparty_file:
                    self.write_json({"error": "Upload the Internal Ledger and the Counterparty Statement."}, 400)
                    return
                from recon.leisure_reco import reconcile_leisure_ledgers
                try:
                    bundle = reconcile_leisure_ledgers(
                        internal_file["content"], internal_file["filename"],
                        counterparty_file["content"], counterparty_file["filename"],
                        tolerance=tolerance,
                    )
                except ValueError as e:
                    self.write_json({"error": str(e)}, 400)
                    return
                job_id = uuid4().hex
                payload = {
                    "job_id": job_id,
                    "reco_type": reco_type,
                    **bundle,
                }
                JOBS[job_id] = payload
                self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
                return

            if reco_type == "zepto_receivables":
                from io import BytesIO
                from recon.zepto_receivables import (
                    reconcile_zepto, summarize_zepto, build_zepto_workbook,
                )
                # brand_name (dynamic, multi-brand) drives the Summary labels; the
                # backend resolves it from the brand and passes it in. Tolerance
                # (default 100) is the per-advice header-reconciliation threshold.
                brand_name = (fields.get("brand_name") or "").strip()
                _adv_tol = float(fields.get("tolerance", "100") or 100)
                results = reconcile_zepto(files, advice_tolerance=_adv_tol)
                wb = build_zepto_workbook(results, {"brand_name": brand_name})
                _buf = BytesIO(); wb.save(_buf)
                job_id = uuid4().hex
                _details = getattr(results, "details", {}) or {}
                payload = {
                    "job_id": job_id,
                    "reco_type": reco_type,
                    "summary": summarize_zepto(results),
                    "counts": {"result_rows": len(results)},
                    "results": results,
                    # Stage 2A: surface these to the UI (dashboard tickets/banners).
                    "rejected_advices": getattr(results, "rejected_advices", []) or [],
                    "unknown_types": _details.get("unknown_types", []) or [],
                    "brand_name": brand_name,
                    "_xlsx_bytes": _buf.getvalue(),
                }
                JOBS[job_id] = payload
                self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
                return

            # Receivable Cycle — Combine Tally GST + Sales Order Combine + courier COD
            # settlement (Delhivery/Ekart/Xpressbees) + combined SRN report -> Main Sheet
            # + per-courier COD sheets. Fully self-contained engine (recon/receivable_cycle.py)
            # — does not share code with any other reco agent.
            if reco_type == "receivable_cycle":
                from io import BytesIO
                from recon.receivable_cycle import (
                    reconcile_receivable_cycle, build_receivable_cycle_workbook, MAIN_SHEET_COLUMNS,
                )

                tally_file = files.get("tally_gst")
                sales_order_file = files.get("sales_order")
                if not tally_file or not sales_order_file:
                    self.write_json(
                        {"error": "Upload the Combine Tally GST report (field: tally_gst) and "
                                  "the Sales Order Combine file (field: sales_order)."},
                        400,
                    )
                    return

                def _rc_files(name):
                    val = files.get(name)
                    if val is None:
                        return []
                    items = val if isinstance(val, list) else [val]
                    return [item["content"] for item in items if item.get("content")]

                def _int_or_none(v):
                    try:
                        return int(v) if v not in (None, "") else None
                    except (TypeError, ValueError):
                        return None

                # Receivable Amount calc needs the run's selected period (the "Generate
                # Receivables" month/year, optionally a range via period_end_month/year)
                # to know which SRN/return rows to deduct. Absent month/year -> no deduction.
                _start_month = _int_or_none(fields.get("month"))
                _start_year = _int_or_none(fields.get("year"))
                period = None
                if _start_month and _start_year:
                    period = {
                        "start_month": _start_month,
                        "start_year": _start_year,
                        "end_month": _int_or_none(fields.get("period_end_month")) or _start_month,
                        "end_year": _int_or_none(fields.get("period_end_year")) or _start_year,
                    }

                try:
                    result = reconcile_receivable_cycle({
                        "tally_gst": tally_file["content"],
                        "sales_order": sales_order_file["content"],
                        "delhivery": _rc_files("delhivery"),
                        "ekart": _rc_files("ekart"),
                        "xpressbees": _rc_files("xpressbees"),
                        "srn": _rc_files("srn"),
                    }, period=period)
                except Exception as exc:
                    self.write_json({"error": f"Receivable Cycle reconciliation failed: {exc}"}, 400)
                    return

                wb = build_receivable_cycle_workbook(result)
                _buf = BytesIO(); wb.save(_buf)
                job_id = uuid4().hex
                payload = {
                    "job_id": job_id,
                    "reco_type": reco_type,
                    "summary": result["summary"],
                    "counts": {"result_rows": len(result["main_sheet"])},
                    "results": result["main_sheet"],
                    # COD sub-sheets (Delivery/Ekart/Xpressbees/DTDC/Self shipping) — already
                    # computed for the xlsx above; exposed in the JSON too so both the
                    # just-ran UI view and the Node DB-persistence step see the full sheet
                    # set, not just the Main Sheet.
                    "cod_sheets": result["cod_sheets"],
                    # Explicit column ORDER for Main Sheet + each COD sheet, as arrays —
                    # the frontend uses these instead of deriving column order from a
                    # row's own object keys, because any key that looks like an array
                    # index ("2", "3", "4") gets forced to the front of a JS object's
                    # own-property order regardless of insertion order, no matter what
                    # the source JSON/DB preserved.
                    "main_sheet_columns": MAIN_SHEET_COLUMNS,
                    "cod_sheet_columns": result["cod_columns"],
                    # Receivable Amount: pending (unsettled) Total per courier, minus SRN
                    # returns within the run's period — see receivable_cycle.build_cod_sheets.
                    "receivable_summary": result["receivable_summary"],
                    "_xlsx_bytes": _buf.getvalue(),
                }
                JOBS[job_id] = payload
                self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
                return

            # Default two-file reconciliation (gst_2b_purchase)
            gstr2b_file = files.get("gstr2b")
            purchase_file = files.get("purchase")
            if not gstr2b_file or not purchase_file:
                self.write_json({"error": "Upload both GSTR-2B and Purchase Register files."}, 400)
                return

            gstr2b_records = read_upload(gstr2b_file["filename"], gstr2b_file["content"], "GSTR-2B")
            purchase_records = read_upload(purchase_file["filename"], purchase_file["content"], "Purchase Register")
            results = reconcile(gstr2b_records, purchase_records, tolerance=tolerance)

            job_id = uuid4().hex
            payload = {
                "job_id": job_id,
                "reco_type": reco_type,
                "summary": summarize(results),
                "counts": {
                    "gstr2b_records": len(gstr2b_records),
                    "purchase_records": len(purchase_records),
                    "result_rows": len(results),
                },
                "results": [result.as_dict() for result in results],
            }
            JOBS[job_id] = payload
            self.write_json(payload)
        except Exception as exc:
            self.write_json({"error": str(exc)}, 500)
        finally:
            _RECO_SEMAPHORE.release()

    def handle_einvoice_parse(self) -> None:
        """Parse ONE e-invoice PDF. Returns per-invoice header + line items, or a
        rejection ({ok:false, reason:'not_einvoice'|'parse_error'}) so the caller
        can flag that file without failing the whole batch."""
        try:
            _fields, files = self.read_multipart()
            f = files.get("file") or files.get("pdf") or files.get("card_statement")
            if isinstance(f, list):
                f = f[0] if f else None
            if not f:
                self.write_json({"ok": False, "reason": "no_file"}, 400)
                return
            from recon.einvoice_extract import parse_einvoice, NotAnEInvoice
            fn = f.get("filename", "")
            try:
                r = parse_einvoice(f["content"])
            except NotAnEInvoice:
                self.write_json({"ok": False, "reason": "not_einvoice", "filename": fn})
                return
            except Exception as exc:  # noqa: BLE001
                self.write_json({"ok": False, "reason": "parse_error", "detail": str(exc), "filename": fn})
                return
            items = r.get("line_items", [])
            self.write_json({
                "ok": True, "filename": fn,
                "header": r.get("header", {}),
                "line_items": items,
                "counts": {"line_items": len(items)},
            })
        except Exception as exc:  # noqa: BLE001
            self.write_json({"ok": False, "reason": "error", "detail": str(exc)}, 500)

    def handle_einvoice_build(self) -> None:
        """Build the styled 3-sheet register xlsx from already-parsed invoices and
        register it as a job (so the existing /export.xlsx + Sheets paths work)."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"
            data = json.loads(body or b"{}")
            invoices = data.get("invoices", []) or []
            from io import BytesIO as _BytesIO
            from recon.einvoice_extract import build_workbook, build_register_rows
            job_id = data.get("job_id") or uuid4().hex
            rows = build_register_rows(invoices)
            payload = {
                "job_id": job_id,
                "reco_type": "einvoice_extract",
                "summary": {"invoices": len(invoices), "line_items": len(rows)},
                "counts": {"invoices": len(invoices), "line_items": len(rows)},
                "results": rows,
            }
            try:
                wb = build_workbook(invoices)
                buf = _BytesIO(); wb.save(buf)
                payload["_xlsx_bytes"] = buf.getvalue()
            except Exception as exc:  # noqa: BLE001
                logging.getLogger(__name__).error("einvoice build_workbook failed: %s", exc)
                payload["_xlsx_bytes"] = None
            JOBS[job_id] = payload
            self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
        except Exception as exc:  # noqa: BLE001
            self.write_json({"error": str(exc)}, 500)

    def handle_purchase_extract(self) -> None:
        """Purchase-Invoice mode: extract line items from each uploaded PDF
        (deterministic per known vendor; Gemini only for a new layout) and map every
        line to a Tally stock item via the SKU ladder (master + learned rows passed
        in from the DB by the Node backend). Returns a per-invoice preview."""
        try:
            fields, files = self.read_multipart()
            master = json.loads(fields.get("master_rows", "[]") or "[]")
            learned = json.loads(fields.get("learned_rows", "[]") or "[]")
            use_gemini = str(fields.get("use_gemini", "true")).lower() != "false"
            narration = fields.get("narration", "Excel to tally")
            pdfs = files.get("files") or files.get("file") or []
            if isinstance(pdfs, dict):
                pdfs = [pdfs]
            from recon.purchase_invoice_tally import parse_invoice, BuyerNotUrbanPlant
            from recon.purchase_sku_match import SkuMatcher
            matcher = SkuMatcher(master, learned)
            out_invoices, skipped = [], []
            for f in pdfs:
                fn = f.get("filename", "")
                try:
                    r = parse_invoice(f["content"])
                except BuyerNotUrbanPlant as e:
                    skipped.append({"filename": fn, "reason": str(e)})
                    continue
                except Exception as exc:  # noqa: BLE001
                    skipped.append({"filename": fn, "reason": f"parse_error: {exc}"})
                    continue
                items = [{"desc": it.get("desc"), "vendor_gstin": r.get("seller_gstin"),
                          "rate": it.get("rate"), "hsn": it.get("hsn"), "qty": it.get("qty")}
                         for it in r["items"]]
                maps = matcher.map_lines(items, use_gemini=use_gemini) if items else []
                lines = []
                for it, m in zip(r["items"], maps):
                    lines.append({**it, "map_status": m["status"], "stock_item": m.get("tally") or "",
                                  "sku": m.get("sku"), "confidence": m.get("confidence"),
                                  "candidates": m.get("candidates", []), "needs_add": m.get("needs_add", False)})
                out_invoices.append({
                    "filename": fn, "known_vendor": r.get("known_vendor"),
                    "seller_gstin": r.get("seller_gstin"), "seller_name": r.get("seller_name"),
                    "buyer_gstin": r.get("buyer_gstin"), "buyer_state": r.get("buyer_state"),
                    "intra_state": r.get("intra_state"), "invoice_no": r.get("invoice_no"),
                    "date": r.get("date"), "items": lines,
                })
            self.write_json({"ok": True, "narration": narration,
                             "invoices": out_invoices, "skipped": skipped,
                             "counts": {"invoices": len(out_invoices), "skipped": len(skipped)}})
        except Exception as exc:  # noqa: BLE001
            self.write_json({"ok": False, "error": str(exc)}, 500)

    def handle_purchase_build(self) -> None:
        """Build the 109-column Excel-to-Tally workbook from the (user-resolved)
        invoices and register it as a job so /api/jobs/<id>/export.xlsx serves it."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) if length else b"{}")
            invoices = data.get("invoices", []) or []
            narration = data.get("narration", "Excel to tally")
            job_id = data.get("job_id") or uuid4().hex
            # each invoice's items already carry a resolved 'stock_item'
            for inv in invoices:
                inv.setdefault("items", [])
            from recon.purchase_invoice_tally import build_tally_workbook
            xlsx, review = build_tally_workbook(invoices, narration=narration)
            n_lines = sum(len(inv.get("items", [])) for inv in invoices)
            payload = {
                "job_id": job_id, "reco_type": "purchase_invoice_tally",
                "summary": {"invoices": len(invoices), "line_items": n_lines,
                            "review_items": len(review)},
                "review": review, "_xlsx_bytes": xlsx,
            }
            JOBS[job_id] = payload
            self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
        except Exception as exc:  # noqa: BLE001
            self.write_json({"error": str(exc)}, 500)

    def handle_gstr2b_format_confirm(self) -> None:
        """The accountant's answer on a NEW GSTR-2B layout: {signature, accept}.
        accept=true keeps the column mapping for good; false drops a pending one."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) if length else b"{}")
            sig = str(data.get("signature") or "").strip()
            if not re.fullmatch(r"[0-9a-f]{20}", sig):
                self.write_json({"error": "signature required"}, 400)
                return
            from recon.gstr2b_formats import confirm_template
            out = confirm_template(sig, bool(data.get("accept")))
            self.write_json(out, 200 if out.get("ok") else 404)
        except Exception as exc:  # noqa: BLE001
            self.write_json({"error": str(exc)}, 500)

    def handle_x2beta_build(self) -> None:
        """Build the X2Beta (Tally purchase-import) workbook from Invoice Process
        rows and register it as a job so /api/jobs/<id>/export.xlsx serves it.

        Body: {rows: [...invoice_process rows...], brand_name?, state_labels?}
        One template serves every brand; only the GST ledger block is resolved
        per run (reuse template spelling / create missing / blank unused)."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) if length else b"{}")
            rows = data.get("rows", []) or []
            if not rows:
                self.write_json({"error": "No invoice rows supplied"}, 400)
                return
            job_id = data.get("job_id") or uuid4().hex
            from recon.x2beta_purchase import build_x2beta_workbook
            xlsx, info = build_x2beta_workbook(
                rows,
                brand_name=data.get("brand_name"),
                state_labels=data.get("state_labels") or None,
            )
            payload = {
                "job_id": job_id, "reco_type": "x2beta_purchase",
                "summary": {
                    "input_rows": len(rows), "ledger_lines": info["rows"],
                    "purchases": info["purchases"], "notes": info["notes"],
                },
                "created_columns": info["created_columns"],
                "pruned_columns": info["pruned_columns"],
                "_xlsx_bytes": xlsx,
            }
            JOBS[job_id] = payload
            self.write_json({k: v for k, v in payload.items() if not k.startswith("_")})
        except Exception as exc:  # noqa: BLE001
            self.write_json({"error": str(exc)}, 500)

    def read_multipart(self) -> tuple[dict[str, str], dict[str, dict]]:
        content_type = self.headers.get("Content-Type", "")
        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length)
        logging.info("Multipart: Content-Type=%s, body length=%d", content_type, len(body))
        message = BytesParser(policy=default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
        )
        fields: dict[str, str] = {}
        files: dict[str, dict] = {}
        for part in message.iter_parts():
            disposition = part.get_content_disposition()
            name = part.get_param("name", header="content-disposition")
            filename = part.get_filename()
            content = part.get_payload(decode=True) or b""
            logging.info("  Part: disposition=%s, name=%s, filename=%s, size=%d", disposition, name, filename, len(content))
            if disposition != "form-data":
                continue
            if filename:
                entry = {"filename": filename, "content": content}
                if name in files:
                    existing = files[name]
                    if not isinstance(existing, list):
                        files[name] = [existing]
                    files[name].append(entry)
                else:
                    files[name] = entry
            else:
                fields[name] = content.decode("utf-8", errors="replace")
        def _log_file(v):
            if isinstance(v, list):
                return [{'fn': i['filename'], 'sz': len(i['content'])} for i in v]
            return {'fn': v['filename'], 'sz': len(v['content'])}
        logging.info("Parsed fields: %s, files: %s", list(fields.keys()), {k: _log_file(v) for k, v in files.items()})
        return fields, files

    def serve_static(self, relative_path: str) -> None:
        target = (STATIC / relative_path).resolve()
        if not str(target).startswith(str(STATIC.resolve())) or not target.exists():
            self.write_json({"error": "Not found"}, 404)
            return
        content_type = "text/plain"
        if target.suffix == ".html":
            content_type = "text/html; charset=utf-8"
        elif target.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif target.suffix == ".js":
            content_type = "application/javascript; charset=utf-8"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def write_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload, indent=2, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def export_job(self, job_id: str) -> None:
        payload = JOBS.get(job_id)
        data = None
        reco_type = "gst_2b_purchase"
        # 1) In-memory pre-built bytes — the normal fast path.
        if payload:
            reco_type = payload.get("reco_type", reco_type)
            if payload.get("_xlsx_bytes"):
                data = payload["_xlsx_bytes"]
        # 2) Disk fallback — survives an engine restart that wiped JOBS,
        #    so an already-run job's download still works (no 404, no rebuild).
        if data is None:
            disk_path = _export_path(job_id)
            if disk_path and os.path.exists(disk_path):
                try:
                    with open(disk_path, "rb") as f:
                        data = f.read()
                except Exception:
                    data = None
        # 3) Last resort — rebuild from in-memory results (only if payload present).
        if data is None:
            if not payload:
                self.write_json({"error": "Job not found"}, 404)
                return
            workbook = build_workbook(
                payload["results"],
                payload["summary"],
                payload["counts"],
                payload.get("reco_type", "gst_2b_purchase"),
                pivot=payload.get("pivot"),
                payload=payload,
            )
            from io import BytesIO
            buffer = BytesIO()
            workbook.save(buffer)
            data = buffer.getvalue()
            # Persist the rebuilt bytes so the next download is instant.
            try:
                dp = _export_path(job_id)
                if dp and not os.path.exists(dp):
                    tmp = dp + ".part"
                    with open(tmp, "wb") as f:
                        f.write(data)
                    os.replace(tmp, dp)
            except Exception:
                pass
        self.send_response(200)
        if reco_type == "bank_reco":
            filename_prefix = "bank_statement"
        elif reco_type == "gstr_1_vs_books":
            filename_prefix = "gstr1_vs_books"
        elif reco_type == "gstr_3b_vs_books":
            filename_prefix = "gstr3b_vs_books"
        elif reco_type == "gstr_2b_books_multistate":
            filename_prefix = "2b_vs_books_multistate"
        elif reco_type == "gstr_3b_tally_entry":
            filename_prefix = "gstr3b_tally_entry"
        elif reco_type == "einvoice_reco":
            filename_prefix = "einvoice_reco"
        elif reco_type == "receivable_cycle":
            filename_prefix = "receivable_cycle"
        elif reco_type == "leisure_reco":
            filename_prefix = "leisure_reco"
        elif reco_type == "pdf_bank_extract":
            acct = payload.get("account_no", "")
            filename_prefix = f"bank_statement_{acct}" if acct else "bank_statement_pdf"
        else:
            filename_prefix = "reconciliation"
        self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.send_header("Content-Disposition", f'attachment; filename="{filename_prefix}-{job_id}.xlsx"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            # Client (backend/browser) disconnected mid-download — e.g. it
            # hit its own timeout. Swallow so it doesn't spam the error log.
            pass

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} - {format % args}")


def build_workbook(results: list[dict], summary: dict[str, int], counts: dict[str, int], reco_type: str = "gst_2b_purchase", pivot: list[dict] | None = None, payload: dict | None = None) -> Workbook:
    if reco_type == "einvoice_reco":
        from recon.einvoice_reco import build_einvoice_workbook
        return build_einvoice_workbook((payload or {}).get("_bundle") or {})
    if reco_type == "leisure_reco":
        from recon.leisure_reco import build_leisure_reco_workbook
        return build_leisure_reco_workbook(results, summary, counts, payload=payload)
    if reco_type == "gstr_2b_books":
        from recon.gstr_2b_books import build_gstr2b_books_workbook
        return build_gstr2b_books_workbook(results, payload=payload)
    if reco_type == "gstr_2b_books_multistate":
        # Use MatchResult objects (with suggested_action_3) if available in the job payload
        result_objs = (payload or {}).get("_results_obj") or results
        return build_gstr2b_books_multistate_workbook(result_objs, payload=payload)
    if reco_type == "gstr_2a_2b_books":
        return build_three_way_workbook(results, summary, counts)
    if reco_type == "gstr_3b_vs_2b":
        return build_3b_vs_2b_workbook(results, summary, counts, pivot or [])
    if reco_type == "bank_reco":
        return build_bank_reco_workbook(results, summary, counts)
    if reco_type == "gstr_3b_vs_books":
        return build_gstr3b_vs_books_workbook(payload or {})
    if reco_type == "gstr_1_vs_books" and (payload or {}).get("_multistate"):
        return build_gstr1_multistate_workbook(payload)
    if reco_type == "gstr_1_vs_books":
        return build_gstr1_workbook(
            results, monthly_summary=[], summary=summary, counts=counts, payload=payload
        )
    if reco_type == "gstr_3b_tally_entry":
        monthly_data  = (payload or {}).get("_monthly_data",  [])
        state_summary = (payload or {}).get("_state_summary", [])
        return build_gstr3b_tally_workbook(monthly_data, results, state_summary=state_summary)

    workbook = Workbook()
    summary_sheet = workbook.active
    summary_sheet.title = "Summary"
    summary_sheet.append(["Metric", "Value"])
    summary_sheet.append(["GSTR-2B records", counts["gstr2b_records"]])
    summary_sheet.append(["Purchase records", counts["purchase_records"]])
    summary_sheet.append(["Result rows", counts["result_rows"]])
    summary_sheet.append([])
    summary_sheet.append(["Category", "Count"])
    for category, count in summary.items():
        summary_sheet.append([category, count])
    style_header(summary_sheet)

    categories = sorted({result["category"] for result in results})
    for category in categories:
        sheet = workbook.create_sheet(safe_sheet_title(category))
        write_result_sheet(sheet, [result for result in results if result["category"] == category])
    return workbook


def safe_sheet_title(title: str) -> str:
    cleaned = re.sub(r"[\[\]\*:/\\?]", "-", title).strip()
    return (cleaned or "Sheet")[:31]


def write_result_sheet(sheet, rows: list[dict]) -> None:
    headers = [
        "Category",
        "Confidence",
        "2B GSTIN",
        "PR GSTIN",
        "2B Doc No",
        "PR Doc No",
        "2B Date",
        "PR Date",
        "2B Taxable",
        "PR Taxable",
        "2B Tax",
        "PR Tax",
        "Mismatches",
        "Suggested Action",
        "Explanation",
    ]
    sheet.append(headers)
    for result in rows:
        gstr2b = result.get("gstr2b") or {}
        purchase = result.get("purchase") or {}
        sheet.append(
            [
                result["category"],
                result["confidence"],
                gstr2b.get("supplier_gstin", ""),
                purchase.get("supplier_gstin", ""),
                gstr2b.get("doc_no", ""),
                purchase.get("doc_no", ""),
                gstr2b.get("doc_date", ""),
                purchase.get("doc_date", ""),
                gstr2b.get("taxable_value", ""),
                purchase.get("taxable_value", ""),
                gstr2b.get("total_tax", ""),
                purchase.get("total_tax", ""),
                ", ".join(result.get("mismatch_fields", [])),
                result["suggested_action"],
                result["explanation"],
            ]
        )
    style_header(sheet)


def build_three_way_workbook(results: list[dict], summary: dict[str, int], counts: dict[str, int]) -> Workbook:
    workbook = Workbook()
    summary_sheet = workbook.active
    summary_sheet.title = "Summary"
    summary_sheet.append(["Metric", "Value"])
    summary_sheet.append(["GSTR-2A records", counts.get("gstr2a_records", 0)])
    summary_sheet.append(["GSTR-2B records", counts.get("gstr2b_records", 0)])
    summary_sheet.append(["Books records", counts.get("books_records", 0)])
    summary_sheet.append(["Result rows", counts.get("result_rows", 0)])
    summary_sheet.append([])
    summary_sheet.append(["Category", "Count", "Amount"])
    for category, count in summary.items():
        amount = sum(record_amount(result) for result in results if result["category"] == category)
        summary_sheet.append([category, count, amount])
    style_header(summary_sheet)

    line_sheet = workbook.create_sheet("Invoice-level Matching")
    write_three_way_sheet(line_sheet, results)

    pan_sheet = workbook.create_sheet("PAN Summary")
    pan_totals: dict[str, dict[str, float]] = {}
    for result in results:
        pan = first_value(result, "pan") or "Unknown"
        bucket = pan_totals.setdefault(pan, {"2A": 0.0, "2B": 0.0, "Books": 0.0})
        if result.get("gstr2a"):
            bucket["2A"] += result["gstr2a"].get("doc_value", 0) or 0
        if result.get("gstr2b"):
            bucket["2B"] += result["gstr2b"].get("doc_value", 0) or 0
        if result.get("books"):
            bucket["Books"] += result["books"].get("doc_value", 0) or 0
    pan_sheet.append(["PAN", "As per 2A", "As per 2B", "As per Books", "2A - Books", "2B - Books"])
    for pan, totals in sorted(pan_totals.items()):
        pan_sheet.append([pan, totals["2A"], totals["2B"], totals["Books"], totals["2A"] - totals["Books"], totals["2B"] - totals["Books"]])
    style_header(pan_sheet)

    for category in sorted({result["category"] for result in results}):
        sheet = workbook.create_sheet(safe_sheet_title(category))
        write_three_way_sheet(sheet, [result for result in results if result["category"] == category])
    return workbook


def write_three_way_sheet(sheet, rows: list[dict]) -> None:
    headers = [
        "Category",
        "Confidence",
        "PAN",
        "Supplier",
        "Doc No",
        "2A Value",
        "2B Value",
        "Books Value",
        "Difference",
        "2A Month",
        "2B Month",
        "Books Month",
        "Mismatches",
        "Suggested Action",
        "Explanation",
    ]
    sheet.append(headers)
    for result in rows:
        value_2a = (result.get("gstr2a") or {}).get("doc_value", 0) or 0
        value_2b = (result.get("gstr2b") or {}).get("doc_value", 0) or 0
        value_books = (result.get("books") or {}).get("doc_value", 0) or 0
        portal_value = value_2b if result.get("gstr2b") else value_2a
        sheet.append(
            [
                result["category"],
                result["confidence"],
                first_value(result, "pan"),
                first_value(result, "supplier_name"),
                first_value(result, "doc_no"),
                value_2a,
                value_2b,
                value_books,
                portal_value - value_books,
                (result.get("gstr2a") or {}).get("month", ""),
                (result.get("gstr2b") or {}).get("month", ""),
                (result.get("books") or {}).get("month", ""),
                ", ".join(result.get("mismatch_fields", [])),
                result["suggested_action"],
                result["explanation"],
            ]
        )
    style_header(sheet)


def first_value(result: dict, field: str) -> str:
    for key in ("gstr2a", "gstr2b", "books"):
        record = result.get(key) or {}
        if record.get(field):
            return record[field]
    return ""


def record_amount(result: dict) -> float:
    for key in ("books", "gstr2b", "gstr2a"):
        record = result.get(key)
        if record:
            return record.get("doc_value", 0) or 0
    return 0.0


def style_header(sheet) -> None:
    fill = PatternFill("solid", fgColor="123C69")
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = fill
    for column_cells in sheet.columns:
        max_length = max((len(str(cell.value or "")) for cell in column_cells), default=8)
        sheet.column_dimensions[column_cells[0].column_letter].width = min(max(max_length + 2, 12), 48)


def build_3b_vs_2b_workbook(results: list[dict], summary: dict[str, int], counts: dict[str, int], pivot: list[dict]) -> Workbook:
    """Build the Excel workbook matching the accountant's expected format.

    Pro-accountant sign convention:
      B2B:  2B row = POSITIVE values, 3B mirror row = NEGATIVE (negate 2B)
      CDNR: 2B row = NEGATIVE values (credit notes reduce ITC), 3B mirror row = POSITIVE

    The 3B mirror row ALWAYS uses 2B values (negated) — NOT the raw 3B PR values.
    This ensures every matched pair nets to EXACTLY zero.

    Output ordering:
      1. Matched CDNRs (sorted by date)
      2. Not Claimed in 3B (CDNR entries)
      3. Matched B2B (sorted by date)
      4. Not Claimed in 3B (B2B entries)
      5. Not in 2B entries
    """
    workbook = Workbook()

    # --- Primary sheet: 2B vs 3B (matches accountant's expected output) ---
    ws = workbook.active
    ws.title = "2B vs 3B"
    headers = [
        "Month", "Date", "Invoice No", "Party Name",
        "Value", "CGST", "SGST", "IGST",
        "Source", "Remarks", "Remarks 2 (Detail Explanation)", "Taxable",
        "Effect in Books", "Effect in 9-9C",
    ]
    ws.append(headers)

    def _is_cdnr(r: dict) -> bool:
        """Check if a result originates from a CDNR source."""
        rec_2b = r.get("rec_2b")
        if rec_2b and "CDNR" in (rec_2b.get("source", "") or "").upper():
            return True
        return False

    def _sort_key(r: dict) -> tuple:
        """Sort key: CDNRs first, then B2B; within each group, sort by date."""
        is_cdnr = _is_cdnr(r)
        category = r.get("category", "")
        # Category order: Matched/Amount Mismatch first, then Not Claimed, then Not in 2B
        cat_order = 0 if category in ("Matched", "Amount Mismatch") else 1 if category == "Not Claimed in 3B" else 2
        rec = r.get("rec_2b") or r.get("rec_3b") or {}
        date_str = rec.get("date", "") or ""
        return (0 if is_cdnr else 1, cat_order, date_str)

    sorted_results = sorted(results, key=_sort_key)

    for r in sorted_results:
        category = r.get("category", "")
        rec_2b = r.get("rec_2b")
        rec_3b = r.get("rec_3b")
        is_cdnr = _is_cdnr(r)

        if category in ("Matched", "Amount Mismatch"):
            if rec_2b:
                # Get raw 2B values from portal (always positive in portal)
                value_2b = rec_2b.get("value", 0) or 0
                cgst_2b = rec_2b.get("cgst", 0) or 0
                sgst_2b = rec_2b.get("sgst", 0) or 0
                igst_2b = rec_2b.get("igst", 0) or 0
                taxable_2b = rec_2b.get("taxable", 0) or 0

                if is_cdnr:
                    # CDNR: Credit notes REDUCE ITC → 2B row is NEGATIVE
                    sign_2b = -1
                else:
                    # B2B: Regular invoices → 2B row is POSITIVE
                    sign_2b = 1

                # Row 1: 2B side
                ws.append([
                    rec_2b.get("month", ""),
                    rec_2b.get("date", ""),
                    rec_2b.get("invoice_no", ""),
                    rec_2b.get("party_name", ""),
                    sign_2b * abs(value_2b),
                    sign_2b * abs(cgst_2b) if cgst_2b else 0,
                    sign_2b * abs(sgst_2b) if sgst_2b else 0,
                    sign_2b * abs(igst_2b) if igst_2b else 0,
                    rec_2b.get("source", "2B"),
                    "Matched",
                    None,
                    sign_2b * abs(taxable_2b),
                    None,
                    None,
                ])

                # Row 2: 3B Working mirror row (NEGATE the 2B row → nets to zero)
                # Use 2B values with opposite sign, and 2B party name for consistency
                ws.append([
                    rec_2b.get("month", ""),
                    rec_2b.get("date", ""),
                    rec_2b.get("invoice_no", ""),
                    rec_2b.get("party_name", ""),
                    -sign_2b * abs(value_2b),
                    -sign_2b * abs(cgst_2b) if cgst_2b else 0,
                    -sign_2b * abs(sgst_2b) if sgst_2b else 0,
                    -sign_2b * abs(igst_2b) if igst_2b else 0,
                    "3B Working",
                    "Matched",
                    None,
                    -sign_2b * abs(taxable_2b),
                    None,
                    None,
                ])

        elif category == "Not in 2B":
            # Single row — 3B Working entry not in 2B
            if rec_3b:
                ws.append([
                    rec_3b.get("month", ""),
                    rec_3b.get("date", ""),
                    rec_3b.get("invoice_no", ""),
                    rec_3b.get("party_name", ""),
                    rec_3b.get("value", 0),
                    rec_3b.get("cgst", 0) or 0,
                    rec_3b.get("sgst", 0) or 0,
                    rec_3b.get("igst", 0) or 0,
                    "3B Working",
                    "Not in 2B",
                    rec_3b.get("remarks2", "") or "ITC Reversal",
                    rec_3b.get("taxable", 0),
                    "No effect",
                    "No effect",
                ])

        elif category == "Not Claimed in 3B":
            # Single row — 2B entry not claimed in 3B
            if rec_2b:
                value_2b = rec_2b.get("value", 0) or 0
                cgst_2b = rec_2b.get("cgst", 0) or 0
                sgst_2b = rec_2b.get("sgst", 0) or 0
                igst_2b = rec_2b.get("igst", 0) or 0
                taxable_2b = rec_2b.get("taxable", 0) or 0

                ws.append([
                    rec_2b.get("month", ""),
                    rec_2b.get("date", ""),
                    rec_2b.get("invoice_no", ""),
                    rec_2b.get("party_name", ""),
                    value_2b,
                    cgst_2b if cgst_2b else 0,
                    sgst_2b if sgst_2b else 0,
                    igst_2b if igst_2b else 0,
                    rec_2b.get("source", "2B"),
                    "Not claimed in 3B",
                    rec_2b.get("remarks2", ""),
                    taxable_2b,
                    "No effect",
                    "No effect",
                ])

    style_header(ws)

    # --- Summary sheet ---
    summary_ws = workbook.create_sheet("Summary")
    summary_ws.append(["GSTR-3B vs GSTR-2B Reconciliation"])
    summary_ws.append([])
    summary_ws.append(["Metric", "Value"])
    summary_ws.append(["GSTR-2B records", counts.get("gstr2b_records", 0)])
    summary_ws.append(["GSTR-3B Working records", counts.get("gstr3b_records", 0)])
    summary_ws.append(["Total result rows", counts.get("result_rows", 0)])
    summary_ws.append([])
    summary_ws.append(["Category", "Count"])
    for cat, cnt in summary.items():
        summary_ws.append([cat, cnt])
    style_header_row(summary_ws, 3)
    style_header_row(summary_ws, 8)

    # --- Month Pivot sheet ---
    pv = workbook.create_sheet("Month Pivot")
    pv.append([
        "Month",
        "2B IGST", "2B CGST", "2B SGST",
        "3B IGST", "3B CGST", "3B SGST",
        "IGST Diff", "CGST Diff", "SGST Diff",
        "2B Value", "3B Value", "Value Diff",
    ])
    for row in pivot:
        pv.append([
            row["month"],
            row["igst_2b"], row["cgst_2b"], row["sgst_2b"],
            row["igst_3b"], row["cgst_3b"], row["sgst_3b"],
            row["igst_diff"], row["cgst_diff"], row["sgst_diff"],
            row["value_2b"], row["value_3b"], row["value_diff"],
        ])
    style_header(pv)

    return workbook


def style_header_row(sheet, row_num: int) -> None:
    """Style a specific row as a header (used for multi-section summary sheets)."""
    fill = PatternFill("solid", fgColor="123C69")
    for cell in sheet[row_num]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = fill


def build_gstr1_workbook(
    results: list[dict],
    monthly_summary: list[dict],
    summary: dict[str, int],
    counts: dict[str, int],
    payload: dict | None = None,
) -> Workbook:
    """
    Build the GSTR-1 vs Books output workbook (9 sheets).
    Sheet order:
      1. GST Reco         — 4-section master summary
      2. GSTR-1 Pivot     — (only when PDF uploaded)
      3. B2B Reco         — invoice-level, all Tally columns
      4. B2C Reco         — state+rate aggregation
      5. Final GSTR-1     — raw GSTR-1 data
      6. GSTR2B           — raw GSTR-2B data
      7. GSTR3B           — raw GSTR-3B data
      8. Sales Register   — raw Tally data
      9. Credit Note      — (only when credit note uploaded)
    """
    p = payload or {}
    sections      = p.get("_gst_reco_sections") or {}
    b2b_rows      = p.get("_b2b_reco_rows") or []
    b2c_rows      = p.get("_b2c_reco_rows") or []
    pivot_rows    = p.get("_pivot_rows")
    tally_cols    = p.get("_tally_cols") or []
    raw_gstr1     = p.get("_raw_gstr1") or []
    raw_gstr2b    = p.get("_raw_gstr2b") or []
    raw_gstr3b    = p.get("_raw_gstr3b") or []
    raw_tally     = p.get("_raw_tally") or []
    raw_cn        = p.get("_raw_cn")

    wb = Workbook()

    # -----------------------------------------------------------------------
    # Sheet 1: GST Reco (master summary — 4 sections)
    # -----------------------------------------------------------------------
    ws = wb.active
    ws.title = "GST Reco"
    ws.sheet_view.showGridLines = False

    _section_configs = [
        ("Sales Reco",                "gstr1_vs_gstr3b",    "GSTR-1",        "GSTR-3B"),
        ("As per books (All sales)",  "books_all_vs_gstr1", "As per books",   "GSTR-1 (All sales)"),
        ("As per books B2B",          "books_b2b_vs_gstr1", "As per books B2B", "GSTR-1 B2B"),
        ("As per books B2C",          "books_b2c_vs_gstr1", "As per books B2C", "GSTR-1 B2C"),
    ]

    gstr3b_available = p.get("_gstr3b_available", True)

    current_row = 1
    for section_title, section_key, left_label, right_label in _section_configs:
        rows = sections.get(section_key) or []
        if section_key == "gstr1_vs_gstr3b" and not gstr3b_available:
            current_row = _write_section_unavailable_note(
                ws, current_row, section_title,
                "GSTR-3B not provided — upload an OCTA report that includes the GSTR-3B "
                "sheet to reconcile GSTR-1 against GSTR-3B.",
            )
        else:
            current_row = _write_gst_reco_section(
                ws, current_row, section_title, left_label, right_label, rows, section_key
            )
        current_row += 3  # gap between sections

    _auto_col_width(ws, min_width=12, max_width=22)
    ws.freeze_panes = "B6"

    # -----------------------------------------------------------------------
    # Sheet 2: GSTR-1 Pivot (only when PDF data present)
    # -----------------------------------------------------------------------
    if pivot_rows:
        ws_pivot = wb.create_sheet("GSTR-1 Pivot")
        ws_pivot.sheet_view.showGridLines = False
        _write_pivot_sheet(ws_pivot, pivot_rows)

    # -----------------------------------------------------------------------
    # Sheet 3: B2B Reco
    # -----------------------------------------------------------------------
    ws_b2b = wb.create_sheet("B2B Reco")
    ws_b2b.sheet_view.showGridLines = False
    _write_b2b_reco_sheet(ws_b2b, b2b_rows, tally_cols)

    # -----------------------------------------------------------------------
    # Sheet 4: B2C Reco
    # -----------------------------------------------------------------------
    ws_b2c = wb.create_sheet("B2C Reco")
    ws_b2c.sheet_view.showGridLines = False
    _write_b2c_reco_sheet(ws_b2c, b2c_rows)

    # -----------------------------------------------------------------------
    # Sheets 5–9: Raw passthrough data
    # -----------------------------------------------------------------------
    _write_raw_sheet(wb, "Final GSTR-1", raw_gstr1)
    _write_raw_sheet(wb, "GSTR2B",       raw_gstr2b)
    _write_raw_sheet(wb, "GSTR3B",       raw_gstr3b)
    _write_raw_sheet(wb, "Sales Register", raw_tally)
    if raw_cn is not None:
        _write_raw_sheet(wb, "Credit Note", raw_cn)

    return wb


# ---------------------------------------------------------------------------
# GST Reco section writer
# ---------------------------------------------------------------------------

_NAVY      = "1F3864"
_MED_BLUE  = "2E75B6"
_LIGHT_BLUE = "EBF3FB"
_GREY_TOTAL = "D9D9D9"
_GREEN_FG  = "276221";  _GREEN_BG  = "C6EFCE"
_RED_FG    = "9C0006";  _RED_BG    = "FFC7CE"
_ORANGE_FG = "9C5700";  _ORANGE_BG = "FFEB9C"
_BLUE_FG   = "1F4E79";  _BLUE_BG   = "DDEBF7"

_NUM_FMT = '#,##0.00'
_THIN = Side(style="thin")
_MED  = Side(style="medium")


def _cell_style(cell, bold=False, bg=None, fg="000000", num_fmt=None,
               border=None, align="left", wrap=False):
    cell.font = Font(bold=bold, color=fg)
    if bg:
        cell.fill = PatternFill("solid", fgColor=bg)
    if num_fmt:
        cell.number_format = num_fmt
    if border:
        cell.border = border
    cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=wrap)


def _header_border():
    return Border(left=_THIN, right=_THIN, top=_MED, bottom=_MED)


def _data_border():
    return Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)


def _write_section_unavailable_note(ws, start_row, title, message):
    """Write a section heading plus a note, for a comparison we cannot run."""
    title_cell = ws.cell(row=start_row, column=1, value=title)
    _cell_style(title_cell, bold=True, bg=_NAVY, fg="FFFFFF", align="center")
    start_row += 2

    note = ws.cell(row=start_row, column=1, value=message)
    _cell_style(note, bold=True, bg=_ORANGE_BG, fg=_ORANGE_FG, align="left")
    return start_row + 1


def _write_gst_reco_section(ws, start_row, title, left_label, right_label, rows, section_key):
    """Write a 4-column-group section in the GST Reco sheet."""
    # Title row
    title_cell = ws.cell(row=start_row, column=1, value=title)
    _cell_style(title_cell, bold=True, bg=_NAVY, fg="FFFFFF", align="center")
    start_row += 2

    # Group headers row
    group_headers = [left_label, None, None, None, None, None, None, right_label, None, None, None, None, None, None, "Difference"]
    for ci, val in enumerate(group_headers, 1):
        cell = ws.cell(row=start_row, column=ci, value=val)
        if val:
            _cell_style(cell, bold=True, bg=_MED_BLUE, fg="FFFFFF", align="center")
    start_row += 1

    # Column headers
    COL_HEADERS = ["Month", "Taxable amount", "IGST", "CGST", "SGST", "Total", "",
                   "Month", "Taxable amount", "IGST", "CGST", "SGST", "Total", "",
                   "Month", "Taxable amount", "IGST", "CGST", "SGST", "Total"]
    for ci, h in enumerate(COL_HEADERS, 1):
        cell = ws.cell(row=start_row, column=ci, value=h if h else None)
        _cell_style(cell, bold=True, bg=_MED_BLUE, fg="FFFFFF",
                   border=_header_border(), align="center")
    start_row += 1

    # Map row keys based on section_key
    if "gstr3b" in section_key:
        left_pfx, right_pfx = "gstr1", "gstr3b"
    else:
        left_pfx, right_pfx = ("books", "gstr1") if rows and "books_taxable" in rows[0] else ("gstr1", "gstr3b")
    # Detect actual prefixes from first data row
    if rows:
        keys = list(rows[0].keys())
        left_pfx  = next((k.split("_")[0] for k in keys if "_taxable" in k), left_pfx)
        # second prefix
        matches = [k.split("_")[0] for k in keys if "_taxable" in k]
        right_pfx = matches[1] if len(matches) > 1 else right_pfx

    data_rows = [r for r in rows if r.get("month") != "Total"]
    total_row = next((r for r in rows if r.get("month") == "Total"), None)
    first_data_row = start_row

    for ri, row in enumerate(data_rows):
        is_alt = (ri % 2 == 1)
        bg = _LIGHT_BLUE if is_alt else None
        month = row.get("month", "")

        def g(key, pfx=None):
            for p in ([pfx] if pfx else [left_pfx, right_pfx, ""]):
                v = row.get(f"{p}_{key}" if p else key)
                if v is not None:
                    return v
            return 0

        def lv(k):   return row.get(f"{left_pfx}_{k}", 0) or 0
        def rv(k):   return row.get(f"{right_pfx}_{k}", 0) or 0
        def dv(k):   return row.get(f"diff_{k}", 0) or 0

        vals = [
            month,
            lv("taxable"), lv("igst"), lv("cgst"), lv("sgst"),
            lv("taxable") + lv("igst") + lv("cgst") + lv("sgst"),
            None,
            month,
            rv("taxable"), rv("igst"), rv("cgst"), rv("sgst"),
            rv("taxable") + rv("igst") + rv("cgst") + rv("sgst"),
            None,
            month,
            dv("taxable"), dv("igst"), dv("cgst"), dv("sgst"),
            dv("taxable") + dv("igst") + dv("cgst") + dv("sgst"),
        ]
        for ci, v in enumerate(vals, 1):
            cell = ws.cell(row=start_row, column=ci, value=v)
            is_num = isinstance(v, (int, float)) and v is not None
            is_diff = ci >= 15
            if is_diff and is_num and v < 0:
                _cell_style(cell, bg=bg, fg=_RED_FG, num_fmt=_NUM_FMT, border=_data_border())
            elif is_diff and is_num and v > 0:
                _cell_style(cell, bg=bg, fg="006100", num_fmt=_NUM_FMT, border=_data_border())
            elif is_num:
                _cell_style(cell, bg=bg, num_fmt=_NUM_FMT, border=_data_border(), align="right")
            else:
                _cell_style(cell, bg=bg, bold=(ci in (1, 8, 15)), border=_data_border())
        start_row += 1

    # Total row
    if total_row:
        def lv(k): return total_row.get(f"{left_pfx}_{k}", 0) or 0
        def rv(k): return total_row.get(f"{right_pfx}_{k}", 0) or 0
        def dv(k): return total_row.get(f"diff_{k}", 0) or 0
        tot_vals = [
            "Total",
            lv("taxable"), lv("igst"), lv("cgst"), lv("sgst"),
            lv("taxable") + lv("igst") + lv("cgst") + lv("sgst"),
            None, "Total",
            rv("taxable"), rv("igst"), rv("cgst"), rv("sgst"),
            rv("taxable") + rv("igst") + rv("cgst") + rv("sgst"),
            None, "Total",
            dv("taxable"), dv("igst"), dv("cgst"), dv("sgst"),
            dv("taxable") + dv("igst") + dv("cgst") + dv("sgst"),
        ]
        for ci, v in enumerate(tot_vals, 1):
            cell = ws.cell(row=start_row, column=ci, value=v)
            is_num = isinstance(v, (int, float)) and v is not None
            _cell_style(cell, bold=True, bg=_GREY_TOTAL, num_fmt=_NUM_FMT if is_num else None,
                       border=_header_border(), align="right" if is_num else "left")
        start_row += 1

    return start_row


# ---------------------------------------------------------------------------
# GSTR-1 Pivot sheet
# ---------------------------------------------------------------------------

def _write_pivot_sheet(ws, pivot_rows):
    ws.cell(row=1, column=1, value="GSTR-1 Pivot — Excel (OCTA) vs PDF Validation")
    _cell_style(ws.cell(row=1, column=1), bold=True, bg=_NAVY, fg="FFFFFF")

    headers_top = ["", "Excel (OCTA)", None, None, None, "", "PDF (GST Portal)", None, None, None, "", "Difference"]
    for ci, v in enumerate(headers_top, 1):
        cell = ws.cell(row=3, column=ci, value=v if v else None)
        if v:
            _cell_style(cell, bold=True, bg=_MED_BLUE, fg="FFFFFF", align="center")

    sub_headers = ["Month", "Taxable", "IGST", "CGST", "SGST", "",
                   "Taxable", "IGST", "CGST", "SGST", "",
                   "Taxable", "IGST", "CGST", "SGST"]
    for ci, h in enumerate(sub_headers, 1):
        cell = ws.cell(row=4, column=ci, value=h)
        _cell_style(cell, bold=True, bg=_MED_BLUE, fg="FFFFFF", border=_header_border(), align="center")

    data_rows = [r for r in pivot_rows if r.get("month") != "Total"]
    total_row  = next((r for r in pivot_rows if r.get("month") == "Total"), None)

    for ri, row in enumerate(data_rows):
        is_alt = (ri % 2 == 1)
        bg = _LIGHT_BLUE if is_alt else None
        month = row.get("month", "")
        ev = lambda k: row.get(f"excel_{k}", 0) or 0
        pv = lambda k: row.get(f"pdf_{k}", 0) or 0
        dv = lambda k: row.get(f"diff_{k}", 0) or 0
        vals = [month, ev("taxable"), ev("igst"), ev("cgst"), ev("sgst"), None,
                pv("taxable"), pv("igst"), pv("cgst"), pv("sgst"), None,
                dv("taxable"), dv("igst"), dv("cgst"), dv("sgst")]
        for ci, v in enumerate(vals, 1):
            cell = ws.cell(row=5 + ri, column=ci, value=v)
            is_num = isinstance(v, (int, float)) and v is not None
            is_diff = ci >= 12
            if is_diff and is_num and abs(v) > 1:
                _cell_style(cell, bg=bg, fg=_RED_FG if v < 0 else "006100", num_fmt=_NUM_FMT, border=_data_border())
            elif is_num:
                _cell_style(cell, bg=bg, num_fmt=_NUM_FMT, border=_data_border(), align="right")
            else:
                _cell_style(cell, bg=bg, bold=(ci == 1), border=_data_border())

    if total_row:
        tr = 5 + len(data_rows)
        ev = lambda k: total_row.get(f"excel_{k}", 0) or 0
        pv = lambda k: total_row.get(f"pdf_{k}", 0) or 0
        dv = lambda k: total_row.get(f"diff_{k}", 0) or 0
        vals = ["Total", ev("taxable"), ev("igst"), ev("cgst"), ev("sgst"), None,
                pv("taxable"), pv("igst"), pv("cgst"), pv("sgst"), None,
                dv("taxable"), dv("igst"), dv("cgst"), dv("sgst")]
        for ci, v in enumerate(vals, 1):
            cell = ws.cell(row=tr, column=ci, value=v)
            is_num = isinstance(v, (int, float)) and v is not None
            _cell_style(cell, bold=True, bg=_GREY_TOTAL, num_fmt=_NUM_FMT if is_num else None,
                       border=_header_border(), align="right" if is_num else "left")

    _auto_col_width(ws, min_width=10, max_width=18)
    ws.freeze_panes = "B5"


# ---------------------------------------------------------------------------
# B2B Reco sheet
# ---------------------------------------------------------------------------

_REMARK_COLORS = {
    "Match":                    (_GREEN_FG,  _GREEN_BG),
    "Diff":                     (_ORANGE_FG, _ORANGE_BG),
    "Not in GSTR-1":            (_RED_FG,    _RED_BG),
    "Not in Books":             (_RED_FG,    _RED_BG),
    "Amazon Entry As per Tally":  (_BLUE_FG,  _BLUE_BG),
    "Amazon Entry as per GSTR-1": ("5C3317",  "F0E6D3"),
}


def _write_b2b_reco_sheet(ws, b2b_rows: list[dict], tally_cols: list[str]):
    ws.cell(row=1, column=1, value="Books VS GSTR-1 — B2B Reconciliation")
    _cell_style(ws.cell(row=1, column=1), bold=True, bg=_NAVY, fg="FFFFFF")

    # Dynamic columns = all Tally cols + separator + GSTR-1 cols + Diff + Remark
    tally_display = [c for c in tally_cols if not c.startswith("_")]
    g1_cols    = ["GSTR-1 Invoice No", "GSTR-1 GSTIN", "GSTR-1 Taxable", "GSTR-1 IGST", "GSTR-1 CGST", "GSTR-1 SGST"]
    diff_cols  = ["Diff Taxable", "Diff IGST", "Diff CGST", "Diff SGST"]
    remark_col = ["Remark"]
    all_headers = tally_display + [""] + g1_cols + [""] + diff_cols + [" "] + remark_col

    # Group header row (row 2)
    n_tally = len(tally_display)
    group_row = ws.cell(row=2, column=1, value="Sales Register")
    _cell_style(group_row, bold=True, bg=_MED_BLUE, fg="FFFFFF", align="center")
    g1_start = n_tally + 2
    ws.cell(row=2, column=g1_start, value="GSTR-1")
    _cell_style(ws.cell(row=2, column=g1_start), bold=True, bg=_MED_BLUE, fg="FFFFFF", align="center")
    diff_start = g1_start + len(g1_cols) + 1
    ws.cell(row=2, column=diff_start, value="Difference")
    _cell_style(ws.cell(row=2, column=diff_start), bold=True, bg=_MED_BLUE, fg="FFFFFF", align="center")
    remark_start = diff_start + len(diff_cols) + 1
    ws.cell(row=2, column=remark_start, value="Remark")
    _cell_style(ws.cell(row=2, column=remark_start), bold=True, bg=_NAVY, fg="FFFFFF", align="center")

    # Column headers (row 3)
    for ci, h in enumerate(all_headers, 1):
        cell = ws.cell(row=3, column=ci, value=h or None)
        if h and h.strip():
            _cell_style(cell, bold=True, bg=_MED_BLUE, fg="FFFFFF", border=_header_border(), align="center")

    # Map Tally row keys → internal column names
    _g1_key_map = {
        "GSTR-1 Invoice No": "_gstr1_inv_no",
        "GSTR-1 GSTIN":      "_gstr1_gstin",
        "GSTR-1 Taxable":    "_gstr1_taxable",
        "GSTR-1 IGST":       "_gstr1_igst",
        "GSTR-1 CGST":       "_gstr1_cgst",
        "GSTR-1 SGST":       "_gstr1_sgst",
        "Diff Taxable":      "_diff_taxable",
        "Diff IGST":         "_diff_igst",
        "Diff CGST":         "_diff_cgst",
        "Diff SGST":         "_diff_sgst",
    }

    for ri, row in enumerate(b2b_rows):
        xl_row = ri + 4
        is_alt = (ri % 2 == 1)
        bg = _LIGHT_BLUE if is_alt else None
        remark = row.get("_remark", "")

        ci = 1
        # Tally columns (pass-through)
        for col in tally_display:
            v = row.get(col)
            cell = ws.cell(row=xl_row, column=ci, value=_json_to_xl(v))
            is_num = isinstance(v, (int, float)) and v is not None
            _cell_style(cell, bg=bg, num_fmt=_NUM_FMT if is_num else None,
                       border=_data_border(), align="right" if is_num else "left")
            ci += 1

        ci += 1  # separator

        # GSTR-1 matched columns
        for h in g1_cols:
            key = _g1_key_map.get(h, "")
            v = row.get(key)
            cell = ws.cell(row=xl_row, column=ci, value=_json_to_xl(v))
            is_num = isinstance(v, (int, float)) and v is not None
            _cell_style(cell, bg=bg, num_fmt=_NUM_FMT if is_num else None,
                       border=_data_border(), align="right" if is_num else "left")
            ci += 1

        ci += 1  # separator

        # Diff columns
        for h in diff_cols:
            key = _g1_key_map.get(h, "")
            v = row.get(key)
            cell = ws.cell(row=xl_row, column=ci, value=_json_to_xl(v))
            is_num = isinstance(v, (int, float)) and v is not None
            if is_num and abs(v) > 0.5:
                fg = _RED_FG if v > 0 else "006100"
                _cell_style(cell, bg=bg, fg=fg, num_fmt=_NUM_FMT, border=_data_border(), align="right")
            else:
                _cell_style(cell, bg=bg, num_fmt=_NUM_FMT if is_num else None,
                           border=_data_border(), align="right" if is_num else "left")
            ci += 1

        ci += 1  # separator before remark

        # Remark column
        rfg, rbg = _REMARK_COLORS.get(remark, ("000000", None))
        remark_cell = ws.cell(row=xl_row, column=ci, value=remark)
        _cell_style(remark_cell, bold=True, bg=rbg, fg=rfg, border=_header_border(), align="center")

    _auto_col_width(ws, min_width=8, max_width=30)
    ws.freeze_panes = "A4"


def _json_to_xl(v):
    """Convert stored JSON value back to Excel-friendly value."""
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v
    return str(v)


# ---------------------------------------------------------------------------
# B2C Reco sheet
# ---------------------------------------------------------------------------

def _write_b2c_reco_sheet(ws, b2c_rows: list[dict]):
    ws.cell(row=1, column=1, value="B2C Reconciliation — State + Rate Annual Aggregation")
    _cell_style(ws.cell(row=1, column=1), bold=True, bg=_NAVY, fg="FFFFFF")

    # Group headers (row 2)
    group_map = {1: "GSTR-1", 8: "Books", 15: "Difference"}
    for ci, label in group_map.items():
        cell = ws.cell(row=2, column=ci, value=label)
        _cell_style(cell, bold=True, bg=_MED_BLUE, fg="FFFFFF", align="center")

    # Column headers (row 3)
    headers = [
        "States", "GST Rate", "Taxable Value", "IGST", "CGST", "SGST", "",
        "States", "GST Rate", "Taxable Value", "IGST", "CGST", "SGST", "",
        "Taxable Value", "IGST", "CGST", "SGST",
    ]
    for ci, h in enumerate(headers, 1):
        cell = ws.cell(row=3, column=ci, value=h or None)
        if h and h.strip():
            _cell_style(cell, bold=True, bg=_MED_BLUE, fg="FFFFFF", border=_header_border(), align="center")

    # Data rows
    for ri, row in enumerate(b2c_rows):
        xl_row = ri + 4
        is_alt = (ri % 2 == 1)
        bg = _LIGHT_BLUE if is_alt else None
        state = row.get("state", "")
        rate  = row.get("rate", 0)

        gv = lambda k: row.get(f"gstr1_{k}", 0) or 0
        bv = lambda k: row.get(f"books_{k}", 0) or 0
        dv = lambda k: row.get(f"diff_{k}", 0) or 0

        vals = [
            state, rate,
            gv("taxable"), gv("igst"), gv("cgst"), gv("sgst"), None,
            state, rate,
            bv("taxable"), bv("igst"), bv("cgst"), bv("sgst"), None,
            dv("taxable"), dv("igst"), dv("cgst"), dv("sgst"),
        ]
        for ci, v in enumerate(vals, 1):
            cell = ws.cell(row=xl_row, column=ci, value=v)
            is_num = isinstance(v, (int, float)) and v is not None
            is_diff = ci >= 15
            if is_diff and is_num and abs(v) > 0.5:
                fg = _RED_FG if v < 0 else "006100"
                _cell_style(cell, bg=bg, fg=fg, num_fmt=_NUM_FMT, border=_data_border(), align="right")
            elif is_num:
                _cell_style(cell, bg=bg, num_fmt=_NUM_FMT, border=_data_border(), align="right")
            else:
                _cell_style(cell, bg=bg, border=_data_border())

    # Totals row
    if b2c_rows:
        tr = len(b2c_rows) + 4
        sum_keys = ["gstr1_taxable", "gstr1_igst", "gstr1_cgst", "gstr1_sgst",
                    "books_taxable", "books_igst", "books_cgst", "books_sgst",
                    "diff_taxable", "diff_igst", "diff_cgst", "diff_sgst"]
        sums = {k: sum(row.get(k, 0) or 0 for row in b2c_rows) for k in sum_keys}
        tot_vals = [
            "Total", "",
            sums["gstr1_taxable"], sums["gstr1_igst"], sums["gstr1_cgst"], sums["gstr1_sgst"], None,
            "Total", "",
            sums["books_taxable"], sums["books_igst"], sums["books_cgst"], sums["books_sgst"], None,
            sums["diff_taxable"], sums["diff_igst"], sums["diff_cgst"], sums["diff_sgst"],
        ]
        for ci, v in enumerate(tot_vals, 1):
            cell = ws.cell(row=tr, column=ci, value=v)
            is_num = isinstance(v, (int, float)) and v is not None
            _cell_style(cell, bold=True, bg=_GREY_TOTAL, num_fmt=_NUM_FMT if is_num else None,
                       border=_header_border(), align="right" if is_num else "left")

    _auto_col_width(ws, min_width=10, max_width=22)
    ws.freeze_panes = "A4"


# ---------------------------------------------------------------------------
# Raw passthrough sheet writer
# ---------------------------------------------------------------------------

def _write_raw_sheet(wb: Workbook, title: str, records: list[dict]):
    if not records:
        ws = wb.create_sheet(title)
        ws.cell(row=1, column=1, value="(No data)")
        return
    ws = wb.create_sheet(title)
    ws.sheet_view.showGridLines = False
    headers = list(records[0].keys())
    for ci, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=ci, value=str(h))
        _cell_style(cell, bold=True, bg=_NAVY, fg="FFFFFF", border=_header_border(), align="center")
    for ri, row in enumerate(records, 2):
        is_alt = (ri % 2 == 0)
        bg = _LIGHT_BLUE if is_alt else None
        for ci, h in enumerate(headers, 1):
            v = row.get(h)
            cell = ws.cell(row=ri, column=ci, value=_json_to_xl(v))
            is_num = isinstance(v, (int, float)) and v is not None
            _cell_style(cell, bg=bg, num_fmt=_NUM_FMT if is_num else None,
                       border=_data_border(), align="right" if is_num else "left")
    _auto_col_width(ws, min_width=8, max_width=30)
    ws.freeze_panes = "A2"


# ---------------------------------------------------------------------------
# Auto column width helper
# ---------------------------------------------------------------------------

def _auto_col_width(ws, min_width=10, max_width=40):
    from openpyxl.utils import get_column_letter
    for col_cells in ws.columns:
        max_len = 0
        col_letter = get_column_letter(col_cells[0].column)
        for cell in col_cells:
            try:
                if cell.value is not None:
                    max_len = max(max_len, len(str(cell.value)))
            except Exception:
                pass
        ws.column_dimensions[col_letter].width = min(max(max_len + 2, min_width), max_width)


def resolve_port() -> int:
    """Listen port for this engine instance.

    Python's GIL caps one process at one CPU core for CPU-bound reconciliation,
    so scaling means running several processes — each needs its own port.
    RECO_PORT selects it; unset (or unparseable) keeps the historic 8765 so an
    un-migrated deployment behaves exactly as before.
    """
    try:
        return int(os.environ.get("RECO_PORT", "") or "8765")
    except (TypeError, ValueError):
        return 8765


# ---------------------------------------------------------------------------
# GSTR-1 vs Books — combined / multi-state / multi-month mode
# (recon/gstr_1_multistate.py). Reached only when the UI asks for it
# (gstr1_mode=multistate), when return files arrive under `gstr1_returns`, or
# when more than one GSTR-1 OCTA file is uploaded. A single register + a single
# OCTA file still goes through the original branch above, unchanged.
# ---------------------------------------------------------------------------

def _gstr1_multistate_requested(fields: dict, files: dict) -> bool:
    if str(fields.get("gstr1_mode", "")).strip().lower() in ("multistate", "combined", "multi"):
        return True
    if files.get("gstr1_returns"):
        return True
    return isinstance(files.get("gstr1_octa"), list) or isinstance(files.get("gstr1_pdf"), list)


def _gstr1_file_items(files: dict, *names: str) -> list[dict]:
    out = []
    for name in names:
        val = files.get(name)
        if val is None:
            continue
        for item in (val if isinstance(val, list) else [val]):
            if item and item.get("content"):
                out.append(item)
    return out


_MS_AMT = ("taxable", "igst", "cgst", "sgst")


def _handle_gstr1_multistate(handler, fields: dict, files: dict, tolerance: float) -> None:
    import pandas as _pd
    from io import BytesIO as _BytesIO
    from recon.gstr_1_vs_books import read_tally_sales_raw, read_credit_note_raw
    from recon.gstr_1_multistate import run_gstr1_multistate, records as _ms_records

    tally_items = _gstr1_file_items(files, "tally_sales")
    return_items = _gstr1_file_items(files, "gstr1_returns", "gstr1_octa", "gstr1", "gstr1_pdf", "gstr3b_pdf")
    cn_items = _gstr1_file_items(files, "credit_note")
    if not tally_items:
        handler.write_json({"error": "Upload the Tally Sales Register (all states)."}, 400)
        return
    if not return_items:
        handler.write_json({"error": "Upload at least one GSTR-1 (OCTA Excel or GST portal PDF) or GSTR-3B PDF."}, 400)
        return

    tally_frames = [read_tally_sales_raw(it) for it in tally_items]
    tally_df = _pd.concat(tally_frames, ignore_index=True) if len(tally_frames) > 1 else tally_frames[0]
    cn_df = None
    if cn_items:
        cn_frames = [read_credit_note_raw(it) for it in cn_items]
        cn_df = _pd.concat(cn_frames, ignore_index=True) if len(cn_frames) > 1 else cn_frames[0]

    res = run_gstr1_multistate(tally_df, cn_df, return_items, tolerance, tally_files=tally_items)

    tally_cols = res["register_cols"]
    from recon.gstr_1_vs_books import _find_col as _fc
    _probe = _pd.DataFrame(columns=tally_cols)
    _inv_k = _fc(_probe, ["Voucher No.", "Voucher No", "Invoice No", "Doc No", "Bill No"])
    _date_k = _fc(_probe, ["Date", "Invoice Date", "Voucher Date"])
    _part_k = _fc(_probe, ["Particulars", "Party Name", "Buyer", "Ledger Name"])
    _gst_k = _fc(_probe, ["GSTIN", "GSTIN/UIN", "Buyer GSTIN"])
    b2b_ui_rows = [{
        "state": _r.get("_reg_state"), "reg_gstin": _r.get("_reg_gstin"),
        "date": _r.get(_date_k), "inv_no": _r.get(_inv_k), "party": _r.get(_part_k), "gstin": _r.get(_gst_k),
        "t_taxable": _r.get("Total Sales", 0), "t_igst": _r.get("Total IGST", 0),
        "t_cgst": _r.get("Total CGST", 0), "t_sgst": _r.get("Total SGST", 0),
        "g1_inv": _r.get("_gstr1_inv_no"), "g1_taxable": _r.get("_gstr1_taxable", 0),
        "g1_igst": _r.get("_gstr1_igst", 0), "g1_cgst": _r.get("_gstr1_cgst", 0), "g1_sgst": _r.get("_gstr1_sgst", 0),
        "diff_taxable": _r.get("_diff_taxable", 0), "diff_igst": _r.get("_diff_igst", 0),
        "diff_cgst": _r.get("_diff_cgst", 0), "diff_sgst": _r.get("_diff_sgst", 0),
        "remark": _r.get("_remark"), "remark3": _r.get("_remark3", ""),
    } for _r in res["all_b2b"]]

    tot = {side: {k: round(sum(s[f"{side}_{k}"] for s in res["state_summary"]), 2) for k in _MS_AMT}
           for side in ("books", "gstr1", "gstr3b")}
    summary = {
        "Registrations": len(res["regs"]),
        "Books taxable": tot["books"]["taxable"],
        "GSTR-1 taxable": tot["gstr1"]["taxable"],
        "Books - GSTR-1": round(tot["books"]["taxable"] - tot["gstr1"]["taxable"], 2),
        "Unassigned Books rows": res["unassigned_rows"],
        "Checks passed": f"{sum(1 for c in res['checks'] if c['ok'])}/{len(res['checks'])}",
    }
    states_public = [{
        "state": st["state"], "gstin": st["gstin"], "gstr1_source": st["gstr1_source"],
        "books_rows": st["books_rows"], "gstr1_rows": st["gstr1_rows"],
        "gstr3b_available": st["gstr3b_available"], "sections": st["sections"],
        "totals": st["totals"], "summary": st["summary"],
    } for st in res["states"]]

    pdf_rows = []
    for g, per in sorted(res["g1_pdf"].items()):
        for p, v in sorted(per.items()):
            pdf_rows.append({"gstin": g, "period": p, "month": v["month"], "file": v.get("_file"),
                             "nil_filed": v["nil_filed"], "parsed_ok": v["parsed_ok"],
                             "tables": v["tables"], "total": v["total"], "b2b": v["b2b"], "b2c": v["b2c"]})
    p3_rows = []
    for g, per in sorted(res["g3b_pdf"].items()):
        for p, v in sorted(per.items()):
            p3_rows.append({"gstin": g, "period": p, "month": v["month"], "file": v.get("_file"),
                            "filing_date": v.get("filing_date"), "rows": v["rows"],
                            "outward": v["outward"], "parsed_ok": v["parsed_ok"]})

    job_id = uuid4().hex
    payload = {
        "job_id": job_id,
        "reco_type": "gstr_1_vs_books",
        "summary": summary,
        "counts": {
            "tally_rows": int(len(tally_df)),
            "return_files": len(return_items),
            "states": len(res["regs"]),
            "b2b_reco_rows": len(b2b_ui_rows),
            "b2c_reco_rows": len(res["all_b2c"]),
            "total_records": len(b2b_ui_rows) + len(res["all_b2c"]),
        },
        "results": [],
        "_multistate": True,
        "_ms": {
            "state_summary": res["state_summary"], "all_sections": res["all_sections"],
            "states": [{**sp, "pivot_rows": st["pivot_rows"]} for sp, st in zip(states_public, res["states"])],
            "all_b2b": res["all_b2b"], "all_b2c": res["all_b2c"], "tally_cols": tally_cols,
            "status_grid": res["status_grid"], "checks": res["checks"], "files": res["files"],
            "warnings": res["warnings"], "register_row_checks": res["register_row_checks"],
            "pdf_rows": pdf_rows, "p3_rows": p3_rows, "split_ok": res["split_ok"],
            "invoice_mode": res["invoice_mode"], "grand_total": res["grand_total"],
            "unassigned": _ms_records(res["unassigned_df"]),
            "books_with_reg": _ms_records(res["books_with_reg"]),
            "raw_gstr1": _ms_records(res["raw_gstr1"]), "raw_gstr3b": _ms_records(res["raw_gstr3b"]),
            "raw_cn": _ms_records(cn_df) if cn_df is not None else None,
        },
    }
    try:
        _wb = build_gstr1_multistate_workbook(payload)
        _buf = _BytesIO()
        _wb.save(_buf)
        payload["_xlsx_bytes"] = _buf.getvalue()
    except Exception as _e:
        logging.getLogger(__name__).exception("GSTR-1 multi-state workbook failed: %s", _e)
        payload["_xlsx_bytes"] = None
    JOBS[job_id] = payload

    public = {k: v for k, v in payload.items() if not k.startswith("_")}
    public.update({
        "multistate": True,
        "state_summary": res["state_summary"],
        "gst_reco_sections": res["all_sections"],
        "states": states_public,
        "status_grid": res["status_grid"],
        "checks": res["checks"],
        "files": res["files"],
        "warnings": res["warnings"],
        "register_row_checks": res["register_row_checks"],
        "split_ok": res["split_ok"],
        "invoice_mode": res["invoice_mode"],
        "returns_info": res["returns_info"],
        "b2b_ui_rows": b2b_ui_rows,
        "b2c_rows": res["all_b2c"],
    })
    handler.write_json(public)


def _ms_title(ws, row, text, width=20, bg=None):
    c = ws.cell(row=row, column=1, value=text)
    _cell_style(c, bold=True, bg=bg or _NAVY, fg="FFFFFF")
    for ci in range(2, width + 1):
        _cell_style(ws.cell(row=row, column=ci), bg=bg or _NAVY)
    return row + 1


def _ms_table(ws, row, headers, rows, num_cols=None, diff_cols=None, bold_last=False):
    """Plain table: header row + data rows. Returns the next free row."""
    num_cols = set(num_cols or [])
    diff_cols = set(diff_cols or [])
    for ci, h in enumerate(headers, 1):
        _cell_style(ws.cell(row=row, column=ci, value=h), bold=True, bg=_MED_BLUE, fg="FFFFFF",
                    border=_header_border(), align="center", wrap=True)
    row += 1
    for ri, r in enumerate(rows):
        last = bold_last and ri == len(rows) - 1
        bg = _GREY_TOTAL if last else (_LIGHT_BLUE if ri % 2 else None)
        for ci, v in enumerate(r, 1):
            cell = ws.cell(row=row, column=ci, value=_json_to_xl(v) if not isinstance(v, (int, float)) else v)
            is_num = isinstance(v, (int, float)) and not isinstance(v, bool)
            fg = "000000"
            if (ci in diff_cols) and is_num and abs(v) > 1:
                fg = _RED_FG
            _cell_style(cell, bold=last, bg=bg, fg=fg, num_fmt=_NUM_FMT if is_num and ci in num_cols else None,
                        border=_data_border(), align="right" if is_num else "left")
        row += 1
    return row


class _MsStyles:
    """Style objects built ONCE and shared by every cell. The generic writers build a
    new Font/Fill/Border per cell — fine for a single state, but a full-year,
    all-states workbook is millions of cells and spent minutes on styling alone."""
    def __init__(self):
        self.head_font = Font(bold=True, color="FFFFFF")
        self.head_fill = PatternFill("solid", fgColor=_MED_BLUE)
        self.navy_fill = PatternFill("solid", fgColor=_NAVY)
        self.head_align = Alignment(horizontal="center", vertical="center", wrap_text=True)
        self.bold = Font(bold=True)
        self.red = Font(color=_RED_FG)
        self.remark = {k: (Font(bold=True, color=fg), PatternFill("solid", fgColor=bg) if bg else None)
                       for k, (fg, bg) in _REMARK_COLORS.items()}
        self.r3 = (Font(bold=True, color=_ORANGE_FG), PatternFill("solid", fgColor=_ORANGE_BG))


def _ms_fast_sheet(wb, title, headers, rows, st: "_MsStyles", group_row=None, freeze="A2"):
    """Header row + plain data rows; numbers get the money format, nothing else is
    styled per cell. `rows` are lists aligned with `headers`."""
    ws = wb.create_sheet(title)
    r0 = 1
    if group_row:
        for ci, label in group_row:
            c = ws.cell(row=1, column=ci, value=label)
            c.font, c.fill = st.head_font, st.navy_fill
        r0 = 2
    for ci, h in enumerate(headers, 1):
        c = ws.cell(row=r0, column=ci, value=h)
        c.font, c.fill, c.alignment = st.head_font, st.head_fill, st.head_align
    for ri, row in enumerate(rows, r0 + 1):
        for ci, v in enumerate(row, 1):
            if v is None or v == "":
                continue
            c = ws.cell(row=ri, column=ci, value=v if isinstance(v, (int, float)) else _json_to_xl(v))
            if isinstance(v, float):
                c.number_format = _NUM_FMT
    for ci, h in enumerate(headers, 1):
        ws.column_dimensions[ws.cell(row=r0, column=ci).column_letter].width = max(10, min(32, len(str(h)) + 4))
    ws.freeze_panes = ws.cell(row=r0 + 1, column=1).coordinate if freeze else None
    return ws


def _ms_records_sheet(wb, title, records, st):
    if not records:
        return None
    headers = list(records[0].keys())
    return _ms_fast_sheet(wb, title, headers, [[r.get(h) for h in headers] for r in records], st)


def build_gstr1_multistate_workbook(payload: dict) -> Workbook:
    from recon.gstr_2b_books import GST_STATE_CODES
    ms = payload.get("_ms") or {}
    wb = Workbook()
    split_ok = ms.get("split_ok", True)

    # ── Summary ────────────────────────────────────────────────────────────
    ws = wb.active
    ws.title = "Summary"
    ws.sheet_view.showGridLines = False
    r = _ms_title(ws, 1, "GSTR-1 vs Books — All States (taxable value and tax, full period)", 22)
    r += 1
    heads = ["Registration", "GSTIN", "GSTR-1 source", "Books rows",
             "Books Taxable", "Books IGST", "Books CGST", "Books SGST",
             "GSTR-1 Taxable", "GSTR-1 IGST", "GSTR-1 CGST", "GSTR-1 SGST",
             "GSTR-3B Taxable", "GSTR-3B IGST", "GSTR-3B CGST", "GSTR-3B SGST",
             "Books − GSTR-1 Taxable", "Books − GSTR-1 IGST", "Books − GSTR-1 CGST", "Books − GSTR-1 SGST",
             "GSTR-1 − GSTR-3B Taxable", "GSTR-1 − GSTR-3B Tax"]
    rows = []
    tot = [0.0] * 18
    for s in ms.get("state_summary") or []:
        vals = [s[f"books_{k}"] for k in _MS_AMT] + [s[f"gstr1_{k}"] for k in _MS_AMT] + \
               [s[f"gstr3b_{k}"] for k in _MS_AMT] + [s[f"diff_books_gstr1_{k}"] for k in _MS_AMT] + \
               [s["diff_gstr1_gstr3b_taxable"],
                round(s["diff_gstr1_gstr3b_igst"] + s["diff_gstr1_gstr3b_cgst"] + s["diff_gstr1_gstr3b_sgst"], 2)]
        tot = [a + b for a, b in zip(tot, vals)]
        rows.append([s["state"], s["gstin"], s["gstr1_source"], s["books_rows"]] + vals)
    rows.append(["All States", "", "", sum(s["books_rows"] for s in ms.get("state_summary") or [])]
                + [round(v, 2) for v in tot])
    r = _ms_table(ws, r, heads, rows, num_cols=range(5, 23), diff_cols=range(17, 23), bold_last=True)
    ws.cell(row=r, column=1, value="GSTR-3B columns cover only the months a GSTR-3B was uploaded for "
                                   "(see 'Return Status'). Differences are Books minus GSTR-1, and GSTR-1 minus GSTR-3B.")
    r += 2

    r = _ms_title(ws, r, "Checks — nothing dropped, nothing double counted", 22)
    r = _ms_table(ws, r, ["Check", "Expected", "Actual", "Result", "Note"],
                  [[c["check"], c["expected"], c["actual"], "OK" if c["ok"] else "CHECK", c.get("note", "")]
                   for c in ms.get("checks") or []], num_cols={2, 3})
    for rr in range(r - len(ms.get("checks") or []), r):
        cell = ws.cell(row=rr, column=4)
        ok = cell.value == "OK"
        _cell_style(cell, bold=True, bg=_GREEN_BG if ok else _RED_BG, fg=_GREEN_FG if ok else _RED_FG,
                    border=_data_border(), align="center")
    r += 1
    if ms.get("warnings"):
        r = _ms_title(ws, r, "Notes", 22, bg=_ORANGE_FG)
        for w in ms["warnings"]:
            _cell_style(ws.cell(row=r, column=1, value="• " + w), fg=_ORANGE_FG)
            r += 1
    _auto_col_width(ws, min_width=12, max_width=26)
    ws.column_dimensions["A"].width = 60
    ws.freeze_panes = "A4"

    # ── Return Status ──────────────────────────────────────────────────────
    ws = wb.create_sheet("Return Status")
    ws.sheet_view.showGridLines = False
    r = _ms_title(ws, 1, "Which return was read for each registration and month", 7)
    grid = ms.get("status_grid") or []
    r = _ms_table(ws, r + 1, ["Registration", "GSTIN", "Month", "Books has sales", "GSTR-1", "GSTR-3B", "Flag"],
                  [[g["state"], g["gstin"], g["month"], "Yes" if g["books_has_sales"] else "No",
                    g["gstr1"], g["gstr3b"], g["flag"]] for g in grid])
    for rr in range(3, r):
        if ws.cell(row=rr, column=7).value:
            _cell_style(ws.cell(row=rr, column=7), bold=True, bg=_RED_BG, fg=_RED_FG, border=_data_border())
    _auto_col_width(ws, min_width=12, max_width=45)
    ws.freeze_panes = "A3"

    # ── GST Reco (All States, then each registration) ─────────────────────
    ws = wb.create_sheet("GST Reco")
    ws.sheet_view.showGridLines = False
    configs = [
        ("As per books (All sales) vs GSTR-1", "books_all_vs_gstr1", "As per books", "GSTR-1"),
        ("As per books (All sales) vs GSTR-3B 3.1", "books_all_vs_gstr3b", "As per books", "GSTR-3B"),
        ("GSTR-1 vs GSTR-3B", "gstr1_vs_gstr3b", "GSTR-1", "GSTR-3B"),
        ("As per books B2B vs GSTR-1 B2B", "books_b2b_vs_gstr1", "As per books B2B", "GSTR-1 B2B"),
        ("As per books B2C vs GSTR-1 B2C", "books_b2c_vs_gstr1", "As per books B2C", "GSTR-1 B2C"),
    ]
    blocks = [("ALL STATES", None, ms.get("all_sections") or {}, any(s["gstr3b_available"] for s in ms.get("states") or []))]
    for st in ms.get("states") or []:
        title = f"{st['state'].upper()} — {st['gstin']}" if st["gstin"] else st["state"].upper() + " — rows whose state could not be identified"
        blocks.append((title, st, st["sections"], st["gstr3b_available"]))
    r = 1
    for title, st, sections, has_3b in blocks:
        r = _ms_title(ws, r, title, 20, bg=_MED_BLUE)
        r += 1
        for sec_title, key, ll, rl in configs:
            if key in ("books_b2b_vs_gstr1", "books_b2c_vs_gstr1") and not split_ok:
                r = _write_section_unavailable_note(ws, r, sec_title,
                    "Not available — the Sales Register has no Category or buyer-GSTIN column, so Books "
                    "cannot be split into B2B and B2C. Use 'All sales' above.")
            elif "gstr3b" in key and not has_3b:
                r = _write_section_unavailable_note(ws, r, sec_title, "No GSTR-3B uploaded for this registration.")
            else:
                r = _write_gst_reco_section(ws, r, sec_title, ll, rl, sections.get(key) or [], key)
            r += 2
        r += 2
    _auto_col_width(ws, min_width=12, max_width=22)

    # ── GSTR-1 PDF tables ──────────────────────────────────────────────────
    if ms.get("pdf_rows"):
        ws = wb.create_sheet("GSTR-1 PDF Tables")
        ws.sheet_view.showGridLines = False
        r = _ms_title(ws, 1, "GSTR-1 portal PDFs — table-wise taxable value (tax in the Total Liability columns)", 16)
        tabs = [("4A", "4A B2B"), ("4B", "4B B2B RCM"), ("5", "5 B2CL"), ("6A", "6A Export"), ("6B", "6B SEZ"),
                ("6C", "6C Deemed"), ("7", "7 B2CS"), ("9B_R", "9B CDNR"), ("9B_U", "9B CDNUR")]
        heads = ["Registration", "GSTIN", "Period", "Nil"] + [t[1] for t in tabs] + \
                ["Amendments (9A/9C/10)", "TL Taxable", "TL IGST", "TL CGST", "TL SGST", "Self-check", "File"]
        rows = []
        for p in ms["pdf_rows"]:
            t = p["tables"]
            amend = sum((t.get(k) or {}).get("taxable", 0) for k in ("9A_b2b", "9A_b2c", "9C_R", "9C_U", "10"))
            rows.append([GST_STATE_CODES.get(p["gstin"][:2], ""), p["gstin"], p["period"], "Yes" if p["nil_filed"] else ""]
                        + [(t.get(k) or {}).get("taxable", 0) for k, _ in tabs]
                        + [round(amend, 2)] + [p["total"][k] for k in _MS_AMT]
                        + ["OK" if p["parsed_ok"] else "Does not tie", p["file"]])
        _ms_table(ws, r + 1, heads, rows, num_cols=range(5, 20))
        _auto_col_width(ws, min_width=10, max_width=24)
        ws.freeze_panes = "E3"

    if ms.get("p3_rows"):
        ws = wb.create_sheet("GSTR-3B PDF 3.1")
        ws.sheet_view.showGridLines = False
        r = _ms_title(ws, 1, "GSTR-3B portal PDFs — table 3.1 (outward supplies)", 14)
        heads = ["Registration", "GSTIN", "Period", "3.1(a) Taxable", "3.1(a) IGST", "3.1(a) CGST", "3.1(a) SGST",
                 "3.1(b) Zero-rated", "3.1(c) Nil/Exempt", "3.1(d) RCM inward", "3.1(e) Non-GST", "ARN date", "File"]
        rows = []
        for p in ms["p3_rows"]:
            rw = p["rows"]
            a = rw.get("a") or {}
            rows.append([GST_STATE_CODES.get(p["gstin"][:2], ""), p["gstin"], p["period"],
                         a.get("taxable", 0), a.get("igst", 0), a.get("cgst", 0), a.get("sgst", 0),
                         (rw.get("b") or {}).get("taxable", 0), (rw.get("c") or {}).get("taxable", 0),
                         (rw.get("d") or {}).get("taxable", 0), (rw.get("e") or {}).get("taxable", 0),
                         p.get("filing_date"), p["file"]])
        _ms_table(ws, r + 1, heads, rows, num_cols=range(4, 12))
        _auto_col_width(ws, min_width=10, max_width=24)

    # ── Invoice level (only when a GSTR-1 OCTA file was uploaded) ──────────
    st_ = _MsStyles()
    if ms.get("invoice_mode"):
        tally_display = [c for c in (ms.get("tally_cols") or []) if not str(c).startswith("_")]
        g1_keys = [("GSTR-1 Invoice No", "_gstr1_inv_no"), ("GSTR-1 GSTIN", "_gstr1_gstin"),
                   ("GSTR-1 Taxable", "_gstr1_taxable"), ("GSTR-1 IGST", "_gstr1_igst"),
                   ("GSTR-1 CGST", "_gstr1_cgst"), ("GSTR-1 SGST", "_gstr1_sgst")]
        d_keys = [("Diff Taxable", "_diff_taxable"), ("Diff IGST", "_diff_igst"),
                  ("Diff CGST", "_diff_cgst"), ("Diff SGST", "_diff_sgst")]
        headers = (["Registration", "Registration GSTIN"] + tally_display + [h for h, _ in g1_keys]
                   + [h for h, _ in d_keys] + ["Remark", "Remark 3 (cross-state)"])
        rows = []
        for x in ms.get("all_b2b") or []:
            rows.append([x.get("_reg_state"), x.get("_reg_gstin")] + [x.get(c) for c in tally_display]
                        + [x.get(k) for _, k in g1_keys] + [x.get(k) for _, k in d_keys]
                        + [x.get("_remark"), x.get("_remark3") or None])
        n_t = 2 + len(tally_display)
        ws = _ms_fast_sheet(wb, "B2B Reco", headers, rows, st_,
                            group_row=[(1, "Sales Register"), (n_t + 1, "GSTR-1"),
                                       (n_t + 7, "Difference (Books − GSTR-1)"), (n_t + 11, "Remarks")])
        rem_col, r3_col = len(headers) - 1, len(headers)
        for ri, x in enumerate(ms.get("all_b2b") or [], 3):
            font, fill = st_.remark.get(x.get("_remark"), (st_.bold, None))
            c = ws.cell(row=ri, column=rem_col)
            c.font = font
            if fill:
                c.fill = fill
            if x.get("_remark3"):
                c3 = ws.cell(row=ri, column=r3_col)
                c3.font, c3.fill = st_.r3
            for dc in range(n_t + 7, n_t + 11):
                v = ws.cell(row=ri, column=dc).value
                if isinstance(v, (int, float)) and abs(v) > 1:
                    ws.cell(row=ri, column=dc).font = st_.red
        ws.column_dimensions[ws.cell(row=2, column=r3_col).column_letter].width = 60
        ws.freeze_panes = "C3"

        ws = wb.create_sheet("B2C Reco")
        ws.sheet_view.showGridLines = False
        _write_b2c_reco_sheet(ws, ms.get("all_b2c") or [])
        for st in ms.get("states") or []:
            if st.get("pivot_rows"):
                ws = wb.create_sheet(f"GSTR-1 Pivot {st['state']}"[:31])
                ws.sheet_view.showGridLines = False
                _write_pivot_sheet(ws, st["pivot_rows"])

    if ms.get("unassigned"):
        _ms_records_sheet(wb, "Unassigned Books", ms["unassigned"], st_)
    if ms.get("register_row_checks"):
        _ms_records_sheet(wb, "Register Row Checks", ms["register_row_checks"], st_)
    _ms_records_sheet(wb, "Files", [{
        "File": f["file"], "Read as": f["kind"], "GSTIN": f["gstin"], "Registration": f["state"],
        "Period(s)": ", ".join(f.get("periods") or []), "Rows": f.get("rows") or "", "Status": f["status"],
        "Note": f.get("note", "")} for f in ms.get("files") or []], st_)
    # The register as reconciled — every row, credit notes folded in, returns netted,
    # with the registration each row was tied to and why. Replaces a separate raw copy.
    _ms_records_sheet(wb, "Sales Register", ms.get("books_with_reg") or [], st_)
    if ms.get("raw_cn") is not None:
        _ms_records_sheet(wb, "Credit Note", ms["raw_cn"], st_)
    if ms.get("raw_gstr1"):
        _ms_records_sheet(wb, "Final GSTR-1", ms["raw_gstr1"], st_)
    if ms.get("raw_gstr3b"):
        _ms_records_sheet(wb, "GSTR3B", ms["raw_gstr3b"], st_)
    return wb



# ---------------------------------------------------------------------------
# GSTR-3B vs Books — its own agent (recon/gstr_3b_vs_books.py). Output in the
# accountant's "GST Summary" layout (state-wise + month-wise) with GSTR-3B on top.
# ---------------------------------------------------------------------------

def _handle_gstr3b_vs_books(handler, fields: dict, files: dict, tolerance: float) -> None:
    from io import BytesIO as _BytesIO
    from recon.gstr_3b_vs_books import run_gstr3b_vs_books
    from recon.gstr_1_vs_books import _FY_MONTHS as _FYM

    tally_items = _gstr1_file_items(files, "tally_sales")
    return_items = _gstr1_file_items(files, "gstr3b_returns", "gstr3b", "gstr3b_pdf")
    cn_items = _gstr1_file_items(files, "credit_note")
    if not tally_items:
        handler.write_json({"error": "Upload the Sales Register (all states)."}, 400)
        return
    res = run_gstr3b_vs_books(tally_items, cn_items, return_items, tolerance)
    summ = res["summ"]

    month_rows = []
    for st in res["states"]:
        for m in _FYM:
            c = res["comp"][st][m]
            if not c["status"]:
                continue
            b, g, d = c["books"], c["g3b"], c["diff"]
            month_rows.append({
                "state": summ["labels"].get(st, st), "gstin": res["gstin_of"].get(st, ""), "month": m,
                "books_taxable": b["net"], "books_tax": round(b["cgst"] + b["sgst"] + b["igst"], 2),
                "gstr3b_taxable": g["net"] if g else None,
                "gstr3b_tax": round(g["cgst"] + g["sgst"] + g["igst"], 2) if g else None,
                "diff_taxable": d["net"] if d else None,
                "diff_tax": round(d["cgst"] + d["sgst"] + d["igst"], 2) if d else None,
                "status": c["status"], "source": c["source"], "doc": c.get("doc", ""),
            })
    summary_rows = []
    for st in res["states"]:
        a = res["comp_annual"][st]
        summary_rows.append({
            "state": summ["labels"].get(st, st), "gstin": res["gstin_of"].get(st, ""),
            "months_with_3b": a["months"], "matched_months": a["matched"],
            "books_cmp_taxable": a["books"]["net"], "gstr3b_taxable": a["g3b"]["net"],
            "diff_taxable": a["diff"]["net"],
            "books_cmp_igst": a["books"]["igst"], "books_cmp_cgst": a["books"]["cgst"], "books_cmp_sgst": a["books"]["sgst"],
            "gstr3b_igst": a["g3b"]["igst"], "gstr3b_cgst": a["g3b"]["cgst"], "gstr3b_sgst": a["g3b"]["sgst"],
            "diff_tax": round(sum(a["diff"][k] for k in ("cgst", "sgst", "igst")), 2),
        })
    books_sections = {sec: [{"state": summ["labels"][s], **summ["annual"][sec][s]} for s in summ["states"]]
                      for sec in ("sales", "interbranch", "returns", "net", "total")}
    cmp_rows = [r for r in month_rows if r["gstr3b_taxable"] is not None]
    matched = sum(1 for r in cmp_rows if r["status"].startswith("Matched"))
    tot_books = round(sum(v["net"] for v in summ["annual"]["total"].values()), 2)
    summary = {
        "Registrations": len(summ["states"]),
        "Books — Sales less Returns incl. Interbranch": tot_books,
        "Months compared (3B / GSTR-1)": len(cmp_rows),
        "…of which vs GSTR-1 (no 3B)": sum(1 for r in cmp_rows if r.get("doc") == "GSTR-1"),
        "Matched months": matched,
        "Checks passed": f"{sum(1 for c in res['checks'] if c['ok'])}/{len(res['checks'])}",
        "total": len(cmp_rows), "matched": matched, "unmatched": len(cmp_rows) - matched,
    }
    job_id = uuid4().hex
    payload = {"job_id": job_id, "reco_type": "gstr_3b_vs_books", "summary": summary,
               "counts": {"register_rows": len(res["books"]["rows"]), "blocks": len(res["books"]["blocks"]),
                          "return_files": len(return_items), "total_records": len(cmp_rows)},
               "results": month_rows, "_g3b_res": res}
    try:
        _wb = build_gstr3b_vs_books_workbook(payload)
        _buf = _BytesIO()
        _wb.save(_buf)
        payload["_xlsx_bytes"] = _buf.getvalue()
    except Exception as _e:
        logging.getLogger(__name__).exception("GSTR-3B vs Books workbook failed: %s", _e)
        payload["_xlsx_bytes"] = None
    payload.pop("_g3b_res", None)        # large; the workbook is already built
    JOBS[job_id] = payload
    public = {k: v for k, v in payload.items() if not k.startswith("_")}
    status_grid = [{"state": r["state"], "gstin": r["gstin"], "month": r["month"],
                    "flag": "Books has sales but no GSTR-3B or GSTR-1 uploaded"} for r in month_rows
                   if r["status"] == "Return not uploaded"]
    public.update({"summary_rows": summary_rows, "books_sections": books_sections, "checks": res["checks"],
                   "notes": res["notes"], "warnings": res["warnings"], "status_grid": status_grid,
                   "files": res["files"], "fy": res["fy"], "company": res["company"],
                   "blocks": [{"label": b["label"], "rows": b["rows"], "basis": b["basis"],
                               "variance": b["variance"]} for b in res["tie"]["blocks"]]})
    try:                                   # the report's eight lines, for the page
        from recon.gstr_3b_report import report_values
        public["report"] = report_values(res)
    except Exception as _e:
        logging.getLogger(__name__).exception("GSTR-3B vs Books report values failed: %s", _e)
    handler.write_json(public)


class _GsStyles:
    """The accountant's GST Summary look."""
    NUM = '#,##0.00;\\(#,##0.00\\);\\-'
    NUM0 = '#,##0;\\(#,##0\\);\\-'

    def __init__(self):
        thin = Side(style="thin", color="BFBFBF")
        self.border = Border(left=thin, right=thin, top=thin, bottom=thin)
        self.title = Font(bold=True, size=14)
        self.sub = Font(size=9, color="595959")
        self.bar_font, self.bar_fill = Font(bold=True, size=11, color="FFFFFF"), PatternFill("solid", fgColor="1F4E78")
        self.head_font, self.head_fill = Font(bold=True, size=10, color="FFFFFF"), PatternFill("solid", fgColor="2E75B6")
        self.sub_font, self.sub_fill = Font(bold=True, size=9, color="FFFFFF"), PatternFill("solid", fgColor="7F7F7F")
        self.tot_fill = PatternFill("solid", fgColor="595959")
        self.body, self.bold = Font(size=10), Font(bold=True, size=10)
        self.center = Alignment(horizontal="center", vertical="center", wrap_text=True)
        self.wrap = Alignment(wrap_text=True, vertical="top")
        self.ok = (Font(bold=True, size=10, color=_GREEN_FG), PatternFill("solid", fgColor=_GREEN_BG))
        self.bad = (Font(bold=True, size=10, color=_RED_FG), PatternFill("solid", fgColor=_RED_BG))
        self.warn = (Font(bold=True, size=10, color=_ORANGE_FG), PatternFill("solid", fgColor=_ORANGE_BG))


def _gs_bar(ws, row, text, width, s):
    for ci in range(1, width + 1):
        c = ws.cell(row=row, column=ci)
        c.fill, c.border = s.bar_fill, s.border
    c = ws.cell(row=row, column=1, value=text)
    c.font = s.bar_font
    return row + 1


def _gs_header(ws, row, heads, s, start_col=1):
    for i, h in enumerate(heads):
        c = ws.cell(row=row, column=start_col + i, value=h)
        c.font, c.fill, c.alignment, c.border = s.head_font, s.head_fill, s.center, s.border
    return row + 1


def _gs_line(ws, row, values, s, bold=False, fmt=None):
    fmt = fmt or s.NUM
    for i, v in enumerate(values):
        c = ws.cell(row=row, column=1 + i, value=v)
        c.border, c.font = s.border, (s.bold if bold else s.body)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            c.number_format = fmt
    return row + 1


def _gs_amounts(a):
    gst = round(a["cgst"] + a["sgst"] + a["igst"], 2)
    return [a["net"], a["cgst"], a["sgst"], a["igst"], gst, round(a["net"] + gst, 2)]


def _gs_return_table(ws, r, title, annual, comp_states, labels, gstin_of, s, total_row=True):
    """Annual Books-vs-return table with every tax head on its own (Books / Return / Diff)."""
    heads = (("net", "Net Sales", "Return Taxable", "Taxable Diff"), ("cgst", "CGST (Books)", "CGST (Return)", "CGST Diff"),
             ("sgst", "SGST (Books)", "SGST (Return)", "SGST Diff"), ("igst", "IGST (Books)", "IGST (Return)", "IGST Diff"))
    hdr = ["State", "GSTIN", "Months compared"]
    for _k, a, b, c in heads:
        hdr += [a if _k != "net" else "Net Sales (Books)", b, c]
    hdr += ["Matched months", "Not matched", "…vs GSTR-1 (no 3B)"]
    r = _gs_bar(ws, r, title, len(hdr), s)
    r = _gs_header(ws, r, hdr, s)
    red = Font(bold=True, size=10, color=_RED_FG)
    diff_cols = {4 + 3 * i + 2 for i in range(4)}           # 1-based columns of the Diff cells
    tot = [0.0] * 12
    for st in comp_states:
        a = annual[st]
        if not a["months"]:
            r = _gs_line(ws, r, [labels.get(st, st), "", 0, "No GSTR-3B or GSTR-1 uploaded for this state"]
                         + [None] * (len(hdr) - 4), s)
            ws.cell(row=r - 1, column=4).font = Font(italic=True, size=10, color="7F7F7F")
            continue
        vals = []
        for k, *_ in heads:
            vals += [a["books"][k], a["g3b"][k], round(a["books"][k] - a["g3b"][k], 2)]
        tot = [x + y for x, y in zip(tot, vals)]
        r = _gs_line(ws, r, [labels.get(st, st), gstin_of.get(st, ""), a["months"]] + vals
                     + [a["matched"], a["months"] - a["matched"], a.get("vs_gstr1", 0)], s)
        for ci in diff_cols:
            v = ws.cell(row=r - 1, column=ci).value
            if isinstance(v, (int, float)) and abs(v) > 1:
                ws.cell(row=r - 1, column=ci).font = red
    if total_row:
        r = _gs_line(ws, r, ["Total", "", sum(annual[st]["months"] for st in comp_states)]
                     + [round(v, 2) for v in tot]
                     + [sum(annual[st]["matched"] for st in comp_states), None, None], s, bold=True)
        for ci in diff_cols:
            v = ws.cell(row=r - 1, column=ci).value
            if isinstance(v, (int, float)) and abs(v) > 1:
                ws.cell(row=r - 1, column=ci).font = red
    return r


def build_gstr3b_vs_books_workbook(payload: dict) -> Workbook:
    """The accountant's approved report: one "1-3B vs Books" tab + the input sheets
    (recon/gstr_3b_report.py). The earlier GST Summary layout is kept below as
    _build_gstr3b_gst_summary_workbook for rollback."""
    from recon.gstr_3b_report import build_report
    res = payload.get("_g3b_res")
    if res is None:
        raise ValueError("GSTR-3B vs Books: result not kept for a rebuild — run the reconciliation again.")
    return build_report(res)


def _build_gstr3b_gst_summary_workbook(payload: dict) -> Workbook:
    from recon.gstr_1_vs_books import _FY_MONTHS as _FYM
    res = payload.get("_g3b_res")
    if res is None:
        raise ValueError("GSTR-3B vs Books: result not kept for a rebuild — run the reconciliation again.")
    s = _GsStyles()
    summ, tie, books = res["summ"], res["tie"], res["books"]
    states, labels = summ["states"], summ["labels"]
    comp_states = res["states"]
    wb = Workbook()

    # =================================================================== GST Summary
    ws = wb.active
    ws.title = "GST Summary"
    ws.sheet_view.showGridLines = False
    who = f" ({res['company']})" if res["company"] else ""
    ws.cell(row=1, column=1, value=f"GST Summary — FY {res['fy']} Sales Register{who}").font = s.title
    blocks_txt = "; ".join(f"{b['label']} rows {b['first_row']}-{b['last_row']}" for b in tie["blocks"])
    ws.cell(row=2, column=1, value="Sales shown EXCLUDING Interbranch Services (separate section). Source: "
                                   f"{blocks_txt}; Nature as marked; each block's own total row used for tie-out."
            ).font = s.sub
    heads = ["State", "Net Sales (Rs.)", "CGST (Rs.)", "SGST (Rs.)", "IGST (Rs.)", "Total GST (Rs.)", "Gross Sales (Rs.)"]
    r = 4
    for title, sec in (("1. SALES SUMMARY (excluding Interbranch)", "sales"),
                       ("2. INTERBRANCH SERVICES (shown separately)", "interbranch"),
                       ("3. SALES RETURNS SUMMARY", "returns"),
                       ("4. NET POSITION (Sales excl. Interbranch, less Returns)", "net")):
        r = _gs_bar(ws, r, title, 7, s)
        r = _gs_header(ws, r, heads, s)
        tot = [0.0] * 6
        for st in states:
            vals = _gs_amounts(summ["annual"][sec][st])
            tot = [a + b for a, b in zip(tot, vals)]
            r = _gs_line(ws, r, [labels[st]] + vals, s)
        r = _gs_line(ws, r, ["Total"] + [round(v, 2) for v in tot], s, bold=True)
        r += 1
    if res["g3b"]:
        r = _gs_return_table(ws, r, "4A. NET POSITION vs GSTR-3B / GSTR-1 (Net Sales excl. Interbranch vs the month's "
                             "GSTR-3B 3.1(a)+(b), else its GSTR-1; Diff = Books − Return, per tax head)",
                             res["comp_net_annual"], comp_states, labels, res["gstin_of"], s)
        r += 1
    r = _gs_bar(ws, r, "5. TOTAL INCLUDING INTERBRANCH (reconciles to register)", 7, s)
    r = _gs_header(ws, r, ["", "Net Value (Rs.)", "CGST (Rs.)", "SGST (Rs.)", "IGST (Rs.)", "Total GST (Rs.)", "Gross (Rs.)"], s)

    def _sum_sec(sec):
        return {k: round(sum(summ["annual"][sec][st][k] for st in states), 2) for k in ("net", "cgst", "sgst", "igst")}
    net_t, ib_t, tot_t = _sum_sec("net"), _sum_sec("interbranch"), _sum_sec("total")
    r = _gs_line(ws, r, ["Net position (Section 4)"] + _gs_amounts(net_t), s)
    r = _gs_line(ws, r, ["Add: Interbranch Services (Section 2)"] + _gs_amounts(ib_t), s)
    r = _gs_line(ws, r, ["Total Sales less Returns"] + _gs_amounts(tot_t), s, bold=True)
    r += 1
    r = _gs_bar(ws, r, "6. MEMO — SALES LEDGER-WISE (Net Value, Sales less Returns)", 7, s)
    r = _gs_header(ws, r, ["Ledger", "Net Value (Rs.)", "", "", "", "", "Rows"], s)
    for x in summ["ledger_memo"]:
        r = _gs_line(ws, r, [x["ledger"], x["net"], None, None, None, None, x["rows"]], s)
    r = _gs_line(ws, r, ["Total", round(sum(x["net"] for x in summ["ledger_memo"]), 2), None, None, None, None,
                         None], s, bold=True)
    r += 1
    r = _gs_bar(ws, r, "7. TIE-OUT TO EACH BLOCK'S OWN TOTAL ROW", 7, s)
    for b in tie["blocks"]:
        r = _gs_header(ws, r, [f"Bridge — {b['label']}", "Net Value (Rs.)", "CGST (Rs.)", "SGST (Rs.)",
                               "IGST (Rs.)", "Total GST (Rs.)", ""], s)
        base = b["sales_less_returns"] if b["basis"].startswith("Sales") else b["compared"]

        def _g(a):
            return [a["net"], a["cgst"], a["sgst"], a["igst"], round(a["cgst"] + a["sgst"] + a["igst"], 2)]
        r = _gs_line(ws, r, [f"{b['basis']} (rows {b['first_row']}-{b['last_row']})"] + _g(base), s)
        for i, x in enumerate(b["bridges"]):
            r = _gs_line(ws, r, [f"({chr(97 + i)}) {x['label']}"] + _g(x), s)
        r = _gs_line(ws, r, ["Adjusted total"] + _g(b["compared"]), s, bold=True)
        if b["grand_total"] is not None:
            r = _gs_line(ws, r, [f"Block total row (row {b['gt_row']})"] + _g(b["grand_total"]), s)
            r = _gs_line(ws, r, ["Unexplained variance"] + _g(b["variance"]), s, bold=True)
        else:
            r = _gs_line(ws, r, ["No total row in this block — nothing to tie to", None, None, None, None, None], s)
        r += 1
    r = _gs_line(ws, r, ["Row count: Sales + Returns vs data rows", tie["n_sales"] + tie["n_returns"],
                         tie["n_rows"], (tie["n_sales"] + tie["n_returns"]) - tie["n_rows"]], s, bold=True, fmt="0")
    r += 2
    if res["g3b"]:
        r = _gs_return_table(ws, r, "8. GSTR-3B / GSTR-1 vs BOOKS (Section 5 incl. Interbranch vs the month's GSTR-3B "
                             "3.1(a)+(b), else its GSTR-1; Diff = Books − Return, per tax head)",
                             res["comp_annual"], comp_states, labels, res["gstin_of"], s)
        r += 1
    r = _gs_bar(ws, r, "Checks", 7, s)
    r = _gs_header(ws, r, ["Check", "Expected", "Actual", "Result", "Note", "", ""], s)
    for c in res["checks"]:
        r = _gs_line(ws, r, [c["check"], c["expected"], c["actual"], "OK" if c["ok"] else "CHECK", c.get("note", "")], s)
        cell = ws.cell(row=r - 1, column=4)
        cell.font, cell.fill = s.ok if c["ok"] else s.bad
    r += 1
    r = _gs_bar(ws, r, "Notes / Data-Quality Flags", 7, s)
    for i, n in enumerate(res["notes"] + res["warnings"], 1):
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=7)
        c = ws.cell(row=r, column=1, value=f"{i}. {n}")
        c.font, c.alignment = s.sub, s.wrap
        ws.row_dimensions[r].height = max(15, 13 * (1 + len(n) // 140))
        r += 1
    ws.column_dimensions["A"].width = 46
    for col, w in (("B", 20), ("C", 18), ("D", 18), ("E", 18), ("F", 18), ("G", 20), ("H", 16), ("I", 14),
                   ("J", 12), ("K", 12)):
        ws.column_dimensions[col].width = w
    for col in "HIJKLMNOPQR":                      # the per-tax-head return tables run to column R
        ws.column_dimensions[col].width = 15
    ws.freeze_panes = "A4"

    # ============================================================ GST Summary - Monthwise
    ws = wb.create_sheet("GST Summary - Monthwise")
    ws.sheet_view.showGridLines = False
    ws.cell(row=1, column=1, value=f"GST Summary — FY {res['fy']} Month-wise, State-wise "
                                   "(Interbranch Services shown separately)").font = s.title
    ws.cell(row=2, column=1, value="Source: " + blocks_txt + ". Month = calendar month of transaction date. "
                                   "Interbranch Services are excluded from Sections 1, 3, 4 and shown only in "
                                   "Sections 2 and 5.").font = s.sub
    sub = ["Net Sales", "CGST", "SGST", "IGST", "Total GST", "Gross"]
    width = 1 + 6 * (len(states) + 1)
    month_ends = res["month_ends"]

    def month_block(r, title, sec):
        r = _gs_bar(ws, r, title, width, s)
        ws.merge_cells(start_row=r, start_column=1, end_row=r + 1, end_column=1)
        c = ws.cell(row=r, column=1, value="Month")
        c.font, c.alignment = s.bold, s.center
        for i, st in enumerate(states + ["Total"]):
            col = 2 + 6 * i
            ws.merge_cells(start_row=r, start_column=col, end_row=r, end_column=col + 5)
            c = ws.cell(row=r, column=col, value=labels.get(st, st))
            c.font, c.alignment = s.head_font, s.center
            c.fill = s.tot_fill if st == "Total" else s.head_fill
            for j, h in enumerate(sub):
                cc = ws.cell(row=r + 1, column=col + j, value=h)
                cc.font, cc.fill, cc.alignment, cc.border = s.sub_font, s.sub_fill, s.center, s.border
        r += 2
        tots = [[0.0] * 6 for _ in range(len(states) + 1)]
        for m in _FYM:
            c = ws.cell(row=r, column=1, value=month_ends[m])
            c.number_format, c.font, c.alignment, c.border = "mmm-yyyy", s.bold, s.center, s.border
            row_tot = [0.0] * 6
            for i, st in enumerate(states):
                vals = _gs_amounts(summ["monthly"][sec][st][m])
                row_tot = [a + b for a, b in zip(row_tot, vals)]
                tots[i] = [a + b for a, b in zip(tots[i], vals)]
                for j, v in enumerate(vals):
                    cc = ws.cell(row=r, column=2 + 6 * i + j, value=v)
                    cc.number_format, cc.border, cc.font = s.NUM0, s.border, s.body
            tots[-1] = [a + b for a, b in zip(tots[-1], row_tot)]
            for j, v in enumerate(row_tot):
                cc = ws.cell(row=r, column=2 + 6 * len(states) + j, value=round(v, 2))
                cc.number_format, cc.border, cc.font = s.NUM0, s.border, s.body
            r += 1
        c = ws.cell(row=r, column=1, value="Total")
        c.font, c.alignment, c.border = s.bold, s.center, s.border
        for i, t in enumerate(tots):
            for j, v in enumerate(t):
                cc = ws.cell(row=r, column=2 + 6 * i + j, value=round(v, 2))
                cc.number_format, cc.border, cc.font = s.NUM0, s.border, s.bold
        return r + 2, tots[-1]

    def net_vs_3b_block(r):
        """Net Position (Section 4) vs GSTR-3B 3.1(a)+(b), per state per month."""
        # Every tax head on its own — the accountant decides which head needs the entry.
        heads = (("net", "Net Sales"), ("cgst", "CGST"), ("sgst", "SGST"), ("igst", "IGST"))
        sub4 = []
        for _k, lab in heads:
            sub4 += [f"{lab} (Books)" if _k != "net" else "Net Sales (Books)",
                     f"{lab} (Return)" if _k != "net" else "Return Taxable",
                     f"{lab} Diff" if _k != "net" else "Taxable Diff"]
        sub4.append("Status")
        W = len(sub4)                                     # 13 columns per registration
        diff_idx = {2, 5, 8, 11}
        cols = comp_states + ["Total"]
        w = 1 + W * len(cols)
        r = _gs_bar(ws, r, "4A. NET POSITION vs GSTR-3B / GSTR-1 — MONTHWISE (Net Sales excl. Interbranch vs the "
                           "month's GSTR-3B 3.1(a)+(b), else its GSTR-1; Diff = Books − Return, per tax head)", w, s)
        ws.merge_cells(start_row=r, start_column=1, end_row=r + 1, end_column=1)
        c = ws.cell(row=r, column=1, value="Month")
        c.font, c.alignment = s.bold, s.center
        for i, st in enumerate(cols):
            col = 2 + W * i
            ws.merge_cells(start_row=r, start_column=col, end_row=r, end_column=col + W - 1)
            gst = res["gstin_of"].get(st, "")
            c = ws.cell(row=r, column=col, value=("All States" if st == "Total" else
                                                  labels.get(st, st) + (f" — {gst}" if gst else "")))
            c.font, c.alignment = s.head_font, s.center
            c.fill = s.tot_fill if st == "Total" else s.head_fill
            for j, h in enumerate(sub4):
                cc = ws.cell(row=r + 1, column=col + j, value=h)
                cc.font, cc.fill, cc.alignment, cc.border = s.sub_font, s.sub_fill, s.center, s.border
        r += 2
        red = Font(bold=True, size=10, color=_RED_FG)

        def _sty(t):
            t = t or ""
            if t.startswith("Matched"):
                return s.ok
            if t.startswith("Short") or t.endswith("filed Nil"):
                return s.bad
            if t.startswith("Excess"):
                return s.warn
            return None

        def _triples(b, g):
            out = []
            for k, _lab in heads:
                if g is None:
                    out += [b[k], None, None]
                else:
                    out += [b[k], g[k], round(b[k] - g[k], 2)]
            return out

        def _put(row, col0, vals, bold=False):
            for j, v in enumerate(vals):
                cc = ws.cell(row=row, column=col0 + j, value=(round(v, 2) if isinstance(v, float) else v))
                cc.border = s.border
                if isinstance(v, (int, float)):
                    cc.number_format = s.NUM0
                    cc.font = s.bold if bold else s.body
                    if j in diff_idx and abs(v) > 1:
                        cc.font = red

        tot = {st: [0.0] * (W - 1) for st in cols}
        for m in _FYM:
            c = ws.cell(row=r, column=1, value=month_ends[m])
            c.number_format, c.font, c.alignment, c.border = "mmm-yyyy", s.bold, s.center, s.border
            all_row, any3b = [0.0] * (W - 1), False
            for i, st in enumerate(comp_states):
                x = res["comp_net"][st][m]
                vals = _triples(x["books"], x["g3b"])
                if x["g3b"] is not None:
                    tot[st] = [a + v for a, v in zip(tot[st], vals)]
                    all_row = [a + v for a, v in zip(all_row, vals)]
                    any3b = True
                _put(r, 2 + W * i, vals)
                sc = ws.cell(row=r, column=2 + W * i + W - 1, value=x["status"] or None)
                sc.border = s.border
                if _sty(x["status"]):
                    sc.font, sc.fill = _sty(x["status"])
                elif x["status"]:
                    sc.font = Font(italic=True, size=9, color="7F7F7F")
            col = 2 + W * len(comp_states)
            if any3b:
                tot["Total"] = [a + v for a, v in zip(tot["Total"], all_row)]
                _put(r, col, all_row)
            else:
                for j in range(W - 1):
                    ws.cell(row=r, column=col + j).border = s.border
            ws.cell(row=r, column=col + W - 1).border = s.border
            r += 1
        c = ws.cell(row=r, column=1, value="Total (months compared)")
        c.font, c.alignment, c.border = s.bold, s.center, s.border
        for i, st in enumerate(cols):
            _put(r, 2 + W * i, tot[st], bold=True)
            ws.cell(row=r, column=2 + W * i + W - 1).border = s.border
        r += 1
        if any(any(abs(v) > 0 for v in (summ["annual"]["interbranch"].get(st) or {}).values()) for st in comp_states):
            ws.cell(row=r, column=1, value="Interbranch Services are reported inside GSTR-3B 3.1(a) too, so a "
                                           "registration that made them shows that amount as a difference here; "
                                           "\"Matched incl. Interbranch\" = the gap is exactly its Interbranch "
                                           "value. The Status table below compares including Interbranch.").font = s.sub
            r += 1
        ws.cell(row=r, column=1, value="Return = the month's GSTR-3B (3.1(a)+(b)); where no GSTR-3B was uploaded, "
                                       "that month's GSTR-1 — shown as \"(vs GSTR-1)\" in Status. See the "
                                       "\"Returns Read\" sheet for which return each month used.").font = s.sub
        r += 1
        return r + 1

    # Month-wise sheet: Sections 1–4, the Net Position vs return table (4A) and the
    # status grid. (Total incl. Interbranch, the annual tie-out, the by-source memo and
    # the incl.-Interbranch comparison stay on the "GST Summary" sheet only.)
    r = 4
    grand = {}
    for title, sec in (("1. SALES — MONTHWISE (excluding Interbranch)", "sales"),
                       ("2. INTERBRANCH SERVICES — MONTHWISE (shown separately)", "interbranch"),
                       ("3. SALES RETURNS — MONTHWISE", "returns"),
                       ("4. NET POSITION — MONTHWISE (Sales excl. Interbranch, less Returns)", "net")):
        r, grand[sec] = month_block(r, title, sec)
        if sec == "net" and res["g3b"]:
            r = net_vs_3b_block(r)
    if res["g3b"]:
        r = _gs_bar(ws, r, "Status — GSTR-3B / GSTR-1 vs Books (Sales less Returns incl. Interbranch)",
                    1 + len(comp_states), s)
        r = _gs_header(ws, r, ["Month"] + [labels.get(st, st) for st in comp_states], s)
        for m in _FYM:
            c = ws.cell(row=r, column=1, value=month_ends[m])
            c.number_format, c.font, c.border = "mmm-yyyy", s.bold, s.border
            for i, st in enumerate(comp_states):
                stt = res["comp"][st][m]["status"]
                cc = ws.cell(row=r, column=2 + i, value=stt or None)
                cc.border = s.border
                sty = (s.ok if stt.startswith("Matched") else s.bad if (stt.startswith("Short") or stt.endswith("filed Nil"))
                       else s.warn if stt.startswith("Excess") else None)
                if sty:
                    cc.font, cc.fill = sty
            r += 1
        r += 1
    ws.cell(row=r, column=1, value='Notes: allocation, Sales/Returns marking and flagged items are described on the '
                                   '"GST Summary" sheet.').font = s.sub
    ws.column_dimensions["A"].width = 30
    for ci in range(2, max(width, 1 + 13 * (len(comp_states) + 1)) + 1):
        ws.column_dimensions[ws.cell(row=1, column=ci).column_letter].width = 14
    for ci in range(2, 2 + len(comp_states)):           # status grid columns carry text
        ws.column_dimensions[ws.cell(row=1, column=ci).column_letter].width = 24
    ws.freeze_panes = "B7"

    # ======================================================= supporting sheets
    st_ = _MsStyles()
    if res["detail"]:
        _ms_records_sheet(wb, "Returns Read", res["detail"], st_)
    data = []
    for r_ in books["rows"]:
        a = r_["amt"]
        gst = round(a["cgst"] + a["sgst"] + a["igst"], 2)
        data.append({
            "Source": r_["source"], "Sheet": r_["sheet"], "Row": r_["row"],
            "Date": r_["date"].strftime("%Y-%m-%d") if r_["date"] else "", "Month": r_["month"],
            "Particulars": r_["particulars"], "Voucher Type": r_["voucher_type"], "Narration": r_["narration"],
            "Nature": r_["nature"], "Interbranch": "Interbranch" if r_["interbranch"] else "External",
            "State field": r_["state_field"], "Eff. State": r_["state_label"], "How assigned": r_["state_why"],
            "State field vs tax-col": "Mismatch" if r_["state_mismatch"] else "OK",
            "Net Value (Excl. GST)": a["net"], "CGST": a["cgst"], "SGST": a["sgst"], "IGST": a["igst"],
            "Total GST": gst, "Gross": round(a["net"] + gst, 2),
            "Register Gross Total": r_["gross"],
        })
    _ms_records_sheet(wb, "Books Data", data, st_)
    if res["files"]:
        _ms_records_sheet(wb, "Files", [{
            "File": f["file"], "Read as": f["kind"], "GSTIN": f["gstin"], "Registration": f["state"],
            "Period(s)": ", ".join(f.get("periods") or []), "Status": f["status"], "Note": f.get("note", "")}
            for f in res["files"]], st_)
    return wb



def main() -> None:
    port = resolve_port()
    server = ThreadingHTTPServer(("0.0.0.0", port), ReconciliationHandler)
    print(f"CA Reconciliation Tool running at http://127.0.0.1:{port}")
    _purge_old_exports()  # clean persisted exports older than a few days
    server.serve_forever()


def build_bank_reco_workbook(results: list[dict], summary: dict[str, int], counts: dict[str, int]) -> Workbook:
    workbook = Workbook()
    
    ws = workbook.active
    ws.title = "OD acc Working"
    headers = ["Txn Date", "Description", "Debit", "Credit", "Balance", "Type ", "Ledger name"]
    ws.append(headers)
    
    for r in results:
        ws.append([
            r.get("txn_date", ""),
            r.get("original_description", ""),
            r.get("debit") if r.get("debit") else None,
            r.get("credit") if r.get("credit") else None,
            r.get("balance", 0),
            r.get("predicted_type", ""),
            r.get("predicted_ledger", "")
        ])
    style_header(ws)
    
    summary_ws = workbook.create_sheet("Summary")
    summary_ws.append(["Bank Statement Classification"])
    summary_ws.append([])
    summary_ws.append(["Metric", "Value"])
    summary_ws.append(["Total Ledgers", counts.get("master_ledgers", 0)])
    summary_ws.append(["Total Bank Rows", counts.get("bank_rows", 0)])
    summary_ws.append([])
    summary_ws.append(["Confidence Level", "Count"])
    for cat, cnt in summary.items():
        summary_ws.append([cat, cnt])
    style_header_row(summary_ws, 3)
    style_header_row(summary_ws, 7)
    
    return workbook

if __name__ == "__main__":
    main()
