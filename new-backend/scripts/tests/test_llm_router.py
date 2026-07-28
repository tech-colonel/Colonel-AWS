"""Tests for the LLM transport router: when it fails over, and when it must NOT.

Two properties matter and both are easy to get wrong:

  1. Failing over on a TRANSIENT error (a timeout, a 429, a 529) abandons a perfectly
     good primary for the whole run because one call was unlucky — and throws away the
     prompt cache already built on it.
  2. NOT failing over on a permanently dead credential means every request pays a failed
     round trip. Anthropic reports an exhausted balance as a 400, not a 402, so the
     status code alone is not enough; the body has to be read.

The concurrency test covers a defect found in the first implementation: layer 3.4 runs
six threads, so several calls are in flight when the primary dies. Only one thread does
the switch; the rest must RETRY on the new transport rather than give up. Before the
fix, 66 of 135 rows were lost to exactly that race.

Run: python3 tests/test_llm_router.py
"""
import io
import os
import socket
import sys
import threading
import urllib.error
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("cl", os.path.join(HERE, "..", "classify.py"))
cl = importlib.util.module_from_spec(_spec)
sys.argv = ["x"]
_spec.loader.exec_module(cl)

FAILURES = []


def check(name, got, want):
    if got == want:
        print(f"{name} PASS")
    else:
        print(f"{name} FAIL  got={got!r} want={want!r}")
        FAILURES.append(name)


def _http(code, body):
    return urllib.error.HTTPError("u", code, "x", {}, io.BytesIO(body.encode()))


def test_credential_finished_predicate():
    cases = [
        # (label, exception, should_fail_over)
        ("400_credit_balance", _http(400, '{"error":{"message":"Your credit balance is too low"}}'), True),
        ("400_quota",          _http(400, '{"error":{"message":"You exceeded your quota"}}'), True),
        ("401_unauthorized",   _http(401, "unauthorized"), True),
        ("403_forbidden",      _http(403, "forbidden"), True),
        # transient / unrelated — must NOT fail over
        ("400_validation",     _http(400, '{"error":{"message":"max_tokens is required"}}'), False),
        ("429_rate_limit",     _http(429, "rate limited"), False),
        ("529_overloaded",     _http(529, "overloaded"), False),
        ("500_server",         _http(500, "oops"), False),
        ("timeout",            socket.timeout("timed out"), False),
        ("conn_reset",         ConnectionResetError("reset"), False),
    ]
    for label, exc, want in cases:
        got, _ = cl._credential_is_finished(exc)
        check(f"test_predicate_{label}", got, want)


def test_router_switches_once_and_is_sticky():
    calls = []

    def fake_post(api_key, model, ask, max_tokens, timeout, base_url=None, cached_block=None):
        calls.append(api_key)
        if api_key == "dead":
            raise _http(400, '{"error":{"message":"Your credit balance is too low"}}')
        return ("ok", {})

    orig, cl._llm_post = cl._llm_post, fake_post
    try:
        r = cl._LLMRouter(("Primary", "dead", None), ("Standby", "live", "http://x"))
        for _ in range(3):
            text, _ = r.post("m", "ask", 10, 5)
            check("test_router_returns_result", text, "ok")
        # dead tried once; every later call goes straight to the standby
        check("test_router_dead_tried_once", calls.count("dead"), 1)
        check("test_router_live_served_all", calls.count("live"), 3)
        check("test_router_switched_flag", r.switched, True)
        check("test_router_label_after_switch", r.label, "Standby")
    finally:
        cl._llm_post = orig


def test_router_concurrent_racers_all_succeed():
    """Six threads hit the dead primary at once; none may be dropped."""
    barrier = threading.Barrier(6)
    served = []
    lock = threading.Lock()

    def fake_post(api_key, model, ask, max_tokens, timeout, base_url=None, cached_block=None):
        if api_key == "dead":
            barrier.wait(timeout=5)      # guarantee a real simultaneous failure
            raise _http(400, '{"error":{"message":"Your credit balance is too low"}}')
        with lock:
            served.append(api_key)
        return ("ok", {})

    orig, cl._llm_post = cl._llm_post, fake_post
    try:
        r = cl._LLMRouter(("Primary", "dead", None), ("Standby", "live", "http://x"))
        errors = []

        def worker():
            try:
                r.post("m", "ask", 10, 5)
            except Exception as e:      # noqa: BLE001 - recorded, asserted below
                errors.append(e)

        threads = [threading.Thread(target=worker) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        check("test_concurrent_no_errors", errors, [])
        check("test_concurrent_all_served", len(served), 6)
    finally:
        cl._llm_post = orig


def test_router_no_standby_reraises():
    def fake_post(api_key, model, ask, max_tokens, timeout, base_url=None, cached_block=None):
        raise _http(401, "unauthorized")

    orig, cl._llm_post = cl._llm_post, fake_post
    try:
        r = cl._LLMRouter(("Only", "dead", None), None)
        try:
            r.post("m", "ask", 10, 5)
            check("test_no_standby_reraises", "no-raise", "raised")
        except urllib.error.HTTPError:
            check("test_no_standby_reraises", "raised", "raised")
    finally:
        cl._llm_post = orig


def test_router_transient_does_not_switch():
    def fake_post(api_key, model, ask, max_tokens, timeout, base_url=None, cached_block=None):
        raise _http(529, "overloaded")

    orig, cl._llm_post = cl._llm_post, fake_post
    try:
        r = cl._LLMRouter(("Primary", "live", None), ("Standby", "other", "http://x"))
        try:
            r.post("m", "ask", 10, 5)
        except urllib.error.HTTPError:
            pass
        check("test_transient_keeps_primary", r.switched, False)
        check("test_transient_keeps_standby", r.standby is not None, True)
    finally:
        cl._llm_post = orig


if __name__ == "__main__":
    test_credential_finished_predicate()
    test_router_switches_once_and_is_sticky()
    test_router_concurrent_racers_all_succeed()
    test_router_no_standby_reraises()
    test_router_transient_does_not_switch()
    print("\n" + ("ALL PASS" if not FAILURES else f"{len(FAILURES)} FAILED: {FAILURES}"))
    sys.exit(1 if FAILURES else 0)
