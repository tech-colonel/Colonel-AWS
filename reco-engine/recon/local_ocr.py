"""
local_ocr.py — second-chance OCR for the PDF → Bank Statement extractor, using a
locally installed Tesseract (CLI, no Python binding needed).

Used ONLY when a no-text-layer PDF's iLovePDF OCR copy did not produce a verified
statement (or iLovePDF was unavailable). Renders each page at 300 dpi with
pdfplumber, runs `tesseract <list> <out> pdf`, and returns a searchable PDF. If the
`tesseract` binary is not installed (e.g. a server without it) this returns None and
nothing changes. Nothing leaves the machine.
"""
import os
import shutil
import logging
import subprocess
import tempfile
from io import BytesIO
from typing import Optional

logger = logging.getLogger(__name__)

_DPI = 300
_TIMEOUT_S = 900


def available() -> bool:
    return shutil.which("tesseract") is not None


def ocr_pdf(pdf_bytes: bytes, password: str = "", max_pages: int = 50) -> Optional[bytes]:
    exe = shutil.which("tesseract")
    if not exe:
        return None
    import pdfplumber
    try:
        with tempfile.TemporaryDirectory(prefix="pdfbank_ocr_") as tmp:
            open_kwargs = {"password": password} if password else {}
            pngs = []
            with pdfplumber.open(BytesIO(pdf_bytes), **open_kwargs) as pdf:
                if len(pdf.pages) > max_pages:
                    logger.info("Local OCR skipped: %d pages > %d.", len(pdf.pages), max_pages)
                    return None
                for i, pg in enumerate(pdf.pages):
                    png = os.path.join(tmp, f"p{i:04d}.png")
                    pg.to_image(resolution=_DPI).save(png)
                    pngs.append(png)
                    try:
                        pg.flush_cache()
                    except Exception:
                        pass
            lst = os.path.join(tmp, "pages.txt")
            with open(lst, "w") as fh:
                fh.write("\n".join(pngs))
            out_base = os.path.join(tmp, "ocr")
            proc = subprocess.run([exe, lst, out_base, "-l", "eng", "--psm", "3", "pdf"],
                                  capture_output=True, timeout=_TIMEOUT_S)
            out = out_base + ".pdf"
            if proc.returncode != 0 or not os.path.exists(out):
                logger.warning("Local tesseract OCR failed (rc=%s): %s", proc.returncode,
                               proc.stderr.decode("utf-8", "ignore")[-200:])
                return None
            with open(out, "rb") as fh:
                data = fh.read()
            logger.info("Local tesseract OCR ok: %d pages → %d bytes.", len(pngs), len(data))
            return data
    except Exception as e:
        logger.warning("Local tesseract OCR error: %s: %s", type(e).__name__, str(e)[:160])
        return None
