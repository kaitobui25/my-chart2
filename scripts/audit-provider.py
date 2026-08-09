#!/usr/bin/env python3
"""Audit the optional FiinQuant provider environment in isolation."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SIDECAR = ROOT / "examples" / "sidecars" / "fiinquant"


def run(*args: str, env: dict[str, str] | None = None) -> None:
    subprocess.run(args, cwd=ROOT, env=env, check=True)


def main() -> None:
    if sys.version_info < (3, 11):
        raise SystemExit("Provider audit requires Python 3.11 or newer")

    with tempfile.TemporaryDirectory(prefix="l2chart-provider-audit-") as temp:
        venv = Path(temp) / "venv"
        run(sys.executable, "-m", "venv", str(venv))
        python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        audit = venv / ("Scripts/pip-audit.exe" if os.name == "nt" else "bin/pip-audit")

        run(str(python), "-m", "pip", "install", "--quiet", "--upgrade",
            "pip", "setuptools>=83", "pip-audit")
        run(str(python), "-m", "pip", "install", "--quiet", "-r",
            str(SIDECAR / "requirements.txt"))
        run(str(python), "-m", "pip", "install", "--quiet", "--upgrade", "-r",
            str(SIDECAR / "requirements-provider.txt"))
        run(str(python), "-m", "pip", "check")
        run(
            str(python),
            "-c",
            "from importlib.metadata import version; "
            "from signalrcore.hub_connection_builder import HubConnectionBuilder; "
            "assert version('fiinquantx') == '0.1.67'; "
            "assert version('signalrcore') == '1.0.2'; "
            "assert version('msgpack') == '1.2.1'; "
            "print('Provider compatibility check: ok')",
        )
        run(str(audit), "--local")

    print(
        "Provider audit passed. Note: pip-audit reports FiinQuantX as unauditable "
        "because it is not indexed on PyPI; review that provider separately."
    )


if __name__ == "__main__":
    main()
