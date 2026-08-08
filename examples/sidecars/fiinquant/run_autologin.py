"""Start the FiinQuant sidecar with optional eager login from the local .env."""

from __future__ import annotations

import os

from aiohttp import web

from fiinquant_sidecar import FiinQuantGateway, build_app, load_env


def main() -> None:
    load_env()
    username = os.environ.get("FIINQUANT_USERNAME", "").strip()
    password = os.environ.get("FIINQUANT_PASSWORD", "")
    gateway = FiinQuantGateway(username, password) if username and password else None

    if gateway is None:
        print(
            "[warning] FIINQUANT_USERNAME/PASSWORD are not configured; "
            "browser Sign in is still required"
        )
    else:
        print("[fiinquant] Signing in with credentials from .env...")
        try:
            gateway._ensure_client()
        except Exception as exc:  # noqa: BLE001
            print(f"[warning] FiinQuant auto-login failed: {str(exc)[:300]}")
        else:
            print("[fiinquant] Auto-login succeeded")

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8720"))
    print(f"FiinQuant sidecar listening on http://{host}:{port}")
    web.run_app(build_app(gateway), host=host, port=port, print=None)


if __name__ == "__main__":
    main()
