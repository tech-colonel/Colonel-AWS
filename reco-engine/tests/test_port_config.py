"""Port configuration for running several engine processes.

Python's GIL means one engine process saturates one CPU core for CPU-bound
reconciliation no matter how many threads it allows. Running N processes is the
only way to use N cores, and each needs its own listen port. RECO_PORT provides
that; unset must keep the historic 8765 so an un-migrated deploy is unaffected.

Stdlib unittest only — neither the dev Mac nor the EC2 box has pytest.
Run:  python3 -m unittest discover -s tests -v
"""

import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _resolve_port(env_value):
    """Run server.resolve_port() in a clean subprocess with RECO_PORT controlled."""
    env = dict(os.environ)
    env.pop("RECO_PORT", None)
    if env_value is not None:
        env["RECO_PORT"] = env_value
    code = (
        "import sys; sys.path.insert(0, %r)\n"
        "from server import resolve_port\n"
        "print(resolve_port())" % str(ROOT)
    )
    out = subprocess.run(
        [sys.executable, "-c", code], env=env, capture_output=True, text=True
    )
    if out.returncode != 0:
        raise AssertionError(out.stderr)
    return int(out.stdout.strip().splitlines()[-1])


class ResolvePortTest(unittest.TestCase):
    def test_defaults_to_8765_when_unset(self):
        self.assertEqual(_resolve_port(None), 8765)

    def test_reads_reco_port(self):
        self.assertEqual(_resolve_port("8766"), 8766)

    def test_falls_back_to_8765_on_garbage(self):
        self.assertEqual(_resolve_port("not-a-number"), 8765)

    def test_falls_back_to_8765_on_empty(self):
        self.assertEqual(_resolve_port(""), 8765)


if __name__ == "__main__":
    unittest.main()
