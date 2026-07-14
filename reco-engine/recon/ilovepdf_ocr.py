"""
ilovepdf_ocr.py — OCR a scanned / no-text-layer PDF via the iLovePDF REST API,
returning a NEW pdf with a searchable text layer. Used ONLY as a fallback by the
PDF → Bank Statement extractor when a PDF has no extractable text (e.g. a scanned
statement, or fonts flattened to vector outlines).

No SDK — raw HTTPS via urllib, consistent with the rest of this codebase. Keys are
read from env (ILOVEPDF_PUBLIC_KEY / ILOVEPDF_SECRET_KEY) or the new-backend/.env
fallback. Cost is O(pages) in iLovePDF credits, so callers must gate this to the
no-text case only — never the happy path.

Flow: auth (public_key → token) → start(pdfocr) → upload → process → download.
"""
import os
import ssl
import json
import uuid
import logging
import urllib.request
import urllib.error

logger = logging.getLogger(__name__)

_API = "https://api.ilovepdf.com"


def _ctx():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _keys():
    """(public_key, secret_key) from env or new-backend/.env — public is what /v1/auth needs."""
    pub = os.environ.get("ILOVEPDF_PUBLIC_KEY")
    sec = os.environ.get("ILOVEPDF_SECRET_KEY")
    if pub:
        return pub.strip(), (sec or "").strip()
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, "..", "..", "new-backend", ".env"),
                 os.path.join(here, "..", "..", "..", "new-backend", ".env")):
        try:
            with open(cand, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line.startswith("ILOVEPDF_PUBLIC_KEY="):
                        pub = line.split("=", 1)[1].strip()
                    elif line.startswith("ILOVEPDF_SECRET_KEY="):
                        sec = line.split("=", 1)[1].strip()
            if pub:
                return pub, (sec or "")
        except Exception:
            continue
    return None, None


def _post_json(url, token, payload, timeout):
    data = json.dumps(payload).encode("utf-8")
    headers = {"content-type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout, context=_ctx()) as r:
        return json.loads(r.read().decode("utf-8"))


def _multipart(fields, file_field, filename, file_bytes):
    """Build a minimal multipart/form-data body (bytes) + content-type header."""
    boundary = "----ilovepdf" + uuid.uuid4().hex
    crlf = b"\r\n"
    buf = []
    for k, v in fields.items():
        buf.append(("--" + boundary).encode())
        buf.append(f'Content-Disposition: form-data; name="{k}"'.encode())
        buf.append(b"")
        buf.append(str(v).encode())
    buf.append(("--" + boundary).encode())
    buf.append(f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"'.encode())
    buf.append(b"Content-Type: application/pdf")
    buf.append(b"")
    buf.append(file_bytes)
    buf.append(("--" + boundary + "--").encode())
    buf.append(b"")
    body = crlf.join(buf)
    return body, f"multipart/form-data; boundary={boundary}"


def _ocr_attempt(pdf_bytes, filename, languages, pub, timeout):
    """One full OCR round-trip (auth → start → upload → process → download).
    Returns the searchable-PDF bytes. Raises on any failure so the caller can retry
    with a fresh token (iLovePDF occasionally 401s 'Signature verification failed')."""
    # 1) auth — fresh token each attempt (tokens can be rejected mid-flow on long jobs)
    token = _post_json(f"{_API}/v1/auth", None, {"public_key": pub}, 30).get("token")
    if not token:
        raise RuntimeError("auth returned no token")
    # 2) start pdfocr → worker server + task
    req = urllib.request.Request(f"{_API}/v1/start/pdfocr",
                                 headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30, context=_ctx()) as r:
        st = json.loads(r.read().decode("utf-8"))
    server, task = st.get("server"), st.get("task")
    if not server or not task:
        raise RuntimeError("start returned no server/task")
    base = f"https://{server}"
    # 3) upload
    body, ct = _multipart({"task": task}, "file", filename, pdf_bytes)
    req = urllib.request.Request(f"{base}/v1/upload", data=body,
                                 headers={"Authorization": f"Bearer {token}", "content-type": ct})
    with urllib.request.urlopen(req, timeout=timeout, context=_ctx()) as r:
        up = json.loads(r.read().decode("utf-8"))
    server_filename = up.get("server_filename")
    if not server_filename:
        raise RuntimeError("upload returned no server_filename")
    # 4) process (OCR)
    _post_json(f"{base}/v1/process", token, {
        "task": task, "tool": "pdfocr",
        "files": [{"server_filename": server_filename, "filename": filename}],
        "ocr_languages": list(languages),
    }, timeout)
    # 5) download
    req = urllib.request.Request(f"{base}/v1/download/{task}",
                                 headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout, context=_ctx()) as r:
        out = r.read()
    if out[:4] == b"%PDF":
        return out
    if out[:2] == b"PK":
        raise RuntimeError("download returned a zip, not a PDF")
    raise RuntimeError("download payload is not a PDF")


def ocr_pdf(pdf_bytes: bytes, filename: str = "statement.pdf",
            languages=("eng",), timeout: int = 300, retries: int = 2):
    """OCR `pdf_bytes` via iLovePDF and return the searchable-PDF bytes, or None on
    failure (missing keys, network, persistent API error). Never raises. Retries with
    a fresh token on a transient failure (e.g. iLovePDF 401 'Signature verification
    failed') since one attempt is known to succeed with the same keys."""
    pub, _sec = _keys()
    if not pub:
        logger.warning("iLovePDF OCR skipped: no ILOVEPDF_PUBLIC_KEY.")
        return None
    for attempt in range(1, retries + 1):
        try:
            out = _ocr_attempt(pdf_bytes, filename, languages, pub, timeout)
            logger.info("iLovePDF OCR ok (attempt %d): %d bytes in → %d bytes out.",
                        attempt, len(pdf_bytes), len(out))
            return out
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:200]
            except Exception:
                pass
            logger.warning("iLovePDF OCR HTTP %s (attempt %d/%d): %s", e.code, attempt, retries, detail)
        except Exception as e:
            logger.warning("iLovePDF OCR failed (attempt %d/%d): %s: %s",
                           attempt, retries, type(e).__name__, str(e)[:160])
    return None
