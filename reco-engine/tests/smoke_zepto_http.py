import os, sys, glob, json, urllib.request, mimetypes
BASE = "http://localhost:8765/api/reconcile"
FX = os.path.join(os.path.dirname(__file__), "fixtures")

def _add(parts, field, path):
    fn = os.path.basename(path)
    with open(path, "rb") as fh: data = fh.read()
    ctype = mimetypes.guess_type(fn)[0] or "application/octet-stream"
    parts.append((field, fn, ctype, data))

def main():
    if not os.path.isdir(FX):
        print("no fixtures dir — skipping HTTP smoke"); return
    parts = [("reco_type", None, None, b"zepto_receivables")]
    for p in glob.glob(f"{FX}/Zepto Payment*"): _add(parts,"zepto_payment",p)
    for p in glob.glob(f"{FX}/GRN_List*"): _add(parts,"grn_list",p)
    for p in glob.glob(f"{FX}/Invoice Details*"): _add(parts,"invoice_details",p)
    for p in glob.glob(f"{FX}/payment_advice*"): _add(parts,"payment_advice",p)
    for p in glob.glob(f"{FX}/Credit Note*"): _add(parts,"credit_note",p)
    boundary = "----zepto"
    body = b""
    for field, fn, ctype, data in parts:
        body += f"--{boundary}\r\n".encode()
        if fn is None:
            body += f'Content-Disposition: form-data; name="{field}"\r\n\r\n'.encode() + data + b"\r\n"
        else:
            body += f'Content-Disposition: form-data; name="{field}"; filename="{fn}"\r\n'.encode()
            body += f"Content-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    resp = json.loads(urllib.request.urlopen(req, timeout=300).read())
    print("job_id:", resp["job_id"], "summary:", resp["summary"])
    assert resp["summary"]["total"] >= 0
    # download the xlsx
    xlsx = urllib.request.urlopen(f"http://localhost:8765/api/jobs/{resp['job_id']}/export.xlsx", timeout=60).read()
    open("/tmp/zepto_out.xlsx","wb").write(xlsx)
    print("wrote /tmp/zepto_out.xlsx", len(xlsx), "bytes")

if __name__ == "__main__": main()
