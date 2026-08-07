"""
tesseract_ocr.py — local OCR for statements whose fonts are flattened to vector
outlines (no text layer), used AHEAD of the iLovePDF fallback.

Why this exists — measured on a real Yes Bank credit-card statement (Feb-26,
6 pages, 102 transactions):

    iLovePDF            53 rows   debits 11,10,142.28   (49 transactions lost)
    Tesseract @300dpi  103 rows   debits 14,78,520.58   (amounts misread)
    Tesseract @600dpi  102 rows   debits 11,78,527.58   (statement: 11,78,855.58)

At 300 dpi Tesseract renders the date separators as digits — '02/02/2026' comes
back as '0210212026' — which silently deleted every February row downstream, and
misreads a leading '1' as '4' ('184.00' -> '484.00'). Both defects disappear at
600 dpi, which is why the resolution is high and not tunable downward by
accident. The remaining 328.00 gap at 600 dpi was two amounts printed as
'144,00' / '184,00' (decimal point read as a comma) and is handled by the
caller's amount parser, not here.

Output is a SEARCHABLE PDF rather than raw text, so the existing extraction
pipeline (pdf_bank_extractor's column geometry, the format-template cache, the
line parser) works unchanged on it.

Deliberately shells out to the `tesseract` and `pdftoppm` binaries instead of
adding a Python OCR dependency: the reco engine is shared by every agent and has
a history of ballooning RAM on the box, so this keeps the memory in a
short-lived subprocess that the OS reclaims.

Requires: tesseract-ocr and poppler-utils (`apt-get install tesseract-ocr
poppler-utils` on the EC2 box; `brew install tesseract` locally).
"""
import os
import re
import shutil
import logging
import subprocess
import tempfile

logger = logging.getLogger(__name__)

# 600 dpi is a correctness floor, not a quality preference — see the module note.
DEFAULT_DPI = 600
# One transaction per printed line, so treat each page as a uniform block.
PSM = "6"
# Per-page ceiling. OCR is CPU-bound and the engine is shared; a 60-page upload
# must not monopolise it.
MAX_PAGES = 50
_PAGE_TIMEOUT = 120
_TOTAL_TIMEOUT = 900


def available() -> bool:
    """Both binaries present? Callers fall back to iLovePDF when not."""
    return bool(shutil.which("tesseract") and shutil.which("pdftoppm"))


def _run(cmd, timeout):
    return subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)


def ocr_pdf(pdf_bytes: bytes, dpi: int = DEFAULT_DPI, password: str = "") -> bytes | None:
    """Rasterise → OCR → re-assemble as a searchable PDF. None if unavailable."""
    if not available():
        logger.info("Tesseract not installed — falling back to iLovePDF.")
        return None

    with tempfile.TemporaryDirectory(prefix="cc-ocr-") as tmp:
        src = os.path.join(tmp, "in.pdf")
        with open(src, "wb") as fh:
            fh.write(pdf_bytes)

        ras = ["pdftoppm", "-r", str(dpi), "-png"]
        if password:
            ras += ["-upw", password]
        ras += [src, os.path.join(tmp, "pg")]
        try:
            r = _run(ras, _TOTAL_TIMEOUT)
        except subprocess.TimeoutExpired:
            logger.warning("Rasterise timed out at %d dpi.", dpi)
            return None
        if r.returncode != 0:
            logger.warning("pdftoppm failed: %s", (r.stderr or b"")[:200])
            return None

        pages = sorted(f for f in os.listdir(tmp) if f.endswith(".png"))
        if not pages:
            return None
        if len(pages) > MAX_PAGES:
            logger.warning("PDF has %d pages — above the %d-page OCR cap.",
                           len(pages), MAX_PAGES)
            return None

        out_pdfs = []
        for name in pages:
            stem = os.path.join(tmp, name[:-4] + "_ocr")
            try:
                r = _run(["tesseract", os.path.join(tmp, name), stem,
                          "--psm", PSM, "pdf"], _PAGE_TIMEOUT)
            except subprocess.TimeoutExpired:
                logger.warning("Tesseract timed out on %s.", name)
                return None
            if r.returncode != 0 or not os.path.exists(stem + ".pdf"):
                logger.warning("Tesseract failed on %s: %s", name, (r.stderr or b"")[:160])
                return None
            out_pdfs.append(stem + ".pdf")

        merged = os.path.join(tmp, "merged.pdf")
        if len(out_pdfs) == 1:
            merged = out_pdfs[0]
        else:
            if not shutil.which("pdfunite"):
                logger.warning("pdfunite missing — cannot merge %d OCR'd pages.", len(out_pdfs))
                return None
            r = _run(["pdfunite", *out_pdfs, merged], _TOTAL_TIMEOUT)
            if r.returncode != 0 or not os.path.exists(merged):
                logger.warning("pdfunite failed: %s", (r.stderr or b"")[:200])
                return None

        with open(merged, "rb") as fh:
            data = fh.read()
        logger.info("Tesseract OCR ok: %d page(s) at %d dpi, %d bytes in -> %d out.",
                    len(pages), dpi, len(pdf_bytes), len(data))
        return data


# ── Digit-whitelisted repair pass ───────────────────────────────────────────
# A second, narrow read used ONLY to recover an amount the main pass could not
# resolve. Restricting the character set stops Tesseract "helpfully" fitting
# letters to digit shapes in the money column. Scoped to the right-hand strip of
# the page, where the Amount column lives on every card statement.
_AMT_CHARS = "0123456789.,DrC"
_AMOUNT_RE = re.compile(r"([\d,]+[.,]\d{2})\s*(Dr|Cr)?", re.I)


def repair_amounts(pdf_bytes: bytes, dpi: int = DEFAULT_DPI, password: str = "",
                   right_fraction: float = 0.28) -> dict:
    """Re-read the amount column alone. Returns {page_index: [amount strings]}.

    Callers use this to fill in rows whose amount failed to parse from the main
    OCR pass; it is not a replacement for it, because the whitelist destroys the
    merchant text that sits on the same line.
    """
    if not available():
        return {}
    out = {}
    with tempfile.TemporaryDirectory(prefix="cc-amt-") as tmp:
        src = os.path.join(tmp, "in.pdf")
        with open(src, "wb") as fh:
            fh.write(pdf_bytes)
        ras = ["pdftoppm", "-r", str(dpi), "-png"]
        if password:
            ras += ["-upw", password]
        ras += [src, os.path.join(tmp, "pg")]
        try:
            if _run(ras, _TOTAL_TIMEOUT).returncode != 0:
                return {}
        except subprocess.TimeoutExpired:
            return {}

        for idx, name in enumerate(sorted(f for f in os.listdir(tmp) if f.endswith(".png"))):
            img = os.path.join(tmp, name)
            try:
                # -crop needs ImageMagick; without it, read the full page under
                # the whitelist. Slightly noisier, still digit-only.
                if shutil.which("magick"):
                    crop = os.path.join(tmp, f"crop{idx}.png")
                    _run(["magick", img, "-gravity", "East", "-crop",
                          f"{int(right_fraction * 100)}%x100%+0+0", "+repage", crop], 60)
                    img = crop if os.path.exists(crop) else img
                r = _run(["tesseract", img, "stdout", "--psm", PSM,
                          "-c", f"tessedit_char_whitelist={_AMT_CHARS}"], _PAGE_TIMEOUT)
            except subprocess.TimeoutExpired:
                continue
            if r.returncode != 0:
                continue
            text = (r.stdout or b"").decode("utf-8", "replace")
            amounts = []
            for line in text.splitlines():
                m = _AMOUNT_RE.search(line.strip())
                if m:
                    amounts.append(m.group(0).strip())
            if amounts:
                out[idx] = amounts
    return out
