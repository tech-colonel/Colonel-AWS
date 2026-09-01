"""
gemini_client.py — minimal Gemini caller (generativelanguage REST, urllib, no SDK).

The ONLY LLM path in the purchase-invoice engine. Used sparingly:
  • a NEW/unknown vendor layout (structure extraction + learn the profile), and
  • SKU mapping ONLY for the unmatched / ambiguous line subset.
Never on the deterministic happy path, so token spend stays tiny.

Key + model come from env, falling back to new-backend/.env (same pattern as the
rest of the engine). Returns None when no key is configured so callers degrade
gracefully to manual pick.
"""
import os
import json
import ssl
import logging
import urllib.request
import urllib.error

logger = logging.getLogger(__name__)

_ENV_FALLBACK = os.path.join(os.path.dirname(__file__), "..", "..", "new-backend", ".env")


def _from_env(name):
    v = os.environ.get(name)
    if v:
        return v.strip()
    try:
        with open(_ENV_FALLBACK) as fh:
            for ln in fh:
                if ln.startswith(name + "="):
                    return ln.split("=", 1)[1].strip()
    except Exception:
        pass
    return None


def _ctx():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def available():
    return bool(_from_env("GEMINI_API_KEY"))


def generate_json(prompt, *, temperature=0.0, timeout=40, max_tokens=2048):
    """Call Gemini and parse a JSON object/array from the reply. None on any failure."""
    key = _from_env("GEMINI_API_KEY")
    if not key:
        return None
    model = _from_env("GEMINI_MODEL") or "gemini-2.5-flash"
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent?key={key}")
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx()) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)
    except (urllib.error.URLError, KeyError, IndexError, ValueError, json.JSONDecodeError) as e:
        logger.warning("Gemini call failed: %s", e)
        return None
