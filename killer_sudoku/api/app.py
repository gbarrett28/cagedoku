"""FastAPI application factory for the COACH killer sudoku coaching tool.

Usage:
    coach                # starts uvicorn and opens browser on http://127.0.0.1:8000
    coach --no-browser   # starts uvicorn without opening the browser
    coach --help         # show CLI options

Host/port are controlled via COACH_HOST / COACH_PORT environment variables
(defaults: 127.0.0.1 / 8000).

The module-level `app` instance is required by uvicorn when invoked as
    uvicorn killer_sudoku.api.app:app
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from killer_sudoku.api.config import CoachConfig
from killer_sudoku.api.routers.puzzle import make_router
from killer_sudoku.api.routers.settings import make_settings_router
from killer_sudoku.api.session import SessionStore
from killer_sudoku.api.settings import SettingsStore

_STATIC_DIR = Path(__file__).parent.parent / "static"


def create_app(config: CoachConfig | None = None) -> FastAPI:
    """Create and configure the COACH FastAPI application.

    Wires together config, session store, and puzzle router. Mounts the
    compiled static frontend if the static/ directory exists (it is absent
    until TypeScript is compiled with `tsc`).

    Args:
        config: Application configuration. Uses CoachConfig() defaults
                (reads COACH_* environment variables) when None.
    """
    if config is None:
        config = CoachConfig()

    store = SessionStore(config.sessions_dir)
    settings_store = SettingsStore(config.settings_file)
    puzzle_router = make_router(config, store, settings_store)
    settings_router = make_settings_router(settings_store)

    application = FastAPI(
        title="COACH — Killer Sudoku Coaching App",
        description="Phase 1: OCR verification and puzzle solving.",
        version="0.1.0",
    )

    application.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    application.include_router(puzzle_router)
    application.include_router(settings_router)

    @application.post("/api/quit")
    async def quit_server() -> dict[str, str]:
        """Gracefully stop the uvicorn server.

        Schedules SIGTERM to the current process 200 ms after returning, giving
        the HTTP response time to reach the client before the server exits.
        """

        def _stop() -> None:
            time.sleep(0.2)
            os.kill(os.getpid(), signal.SIGTERM)

        threading.Thread(target=_stop, daemon=True).start()
        return {"status": "stopping"}

    if _STATIC_DIR.exists():
        application.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")

        @application.get("/")
        async def index() -> FileResponse:
            """Serve the SPA entry point."""
            return FileResponse(_STATIC_DIR / "index.html")

    return application


# Module-level app instance for `uvicorn killer_sudoku.api.app:app`
app = create_app()


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="coach",
        description="COACH — Killer Sudoku Coaching App",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        default=False,
        help="Start the server without opening a browser window.",
    )
    return parser


def serve() -> None:
    """Entry point for the `coach` CLI command.

    Starts uvicorn and (unless --no-browser is passed, or running on Linux/WSL
    where webbrowser.open is unreliable) opens the default browser to the app
    URL after a short delay to let the server bind its port.

    Host/port are read from CoachConfig (COACH_HOST / COACH_PORT env vars).
    Run from the project root so that guardian/ and observer/ model directories
    resolve correctly.
    """
    args = _build_arg_parser().parse_args()
    cfg = CoachConfig()
    url = f"http://{cfg.host}:{cfg.port}"

    # webbrowser.open is unreliable on headless Linux / WSL
    open_browser = not args.no_browser and not sys.platform.startswith("linux")

    print("=" * 60)
    print("COACH — Killer Sudoku Coaching App")
    print("=" * 60)
    print(f"  Server: {url}")
    if sys.platform.startswith("linux"):
        print(f"  Open your browser to: {url}")
    print("  Press Ctrl+C to stop")
    print()

    if open_browser:

        def _open_browser() -> None:
            time.sleep(1.5)  # Give uvicorn time to bind its port
            try:
                webbrowser.open(url)
            except Exception as exc:
                print(f"  Could not open browser: {exc}")
                print(f"  Please open manually: {url}")

        threading.Thread(target=_open_browser, daemon=True).start()

    try:
        uvicorn.run(
            app, host=cfg.host, port=cfg.port, log_level="info", access_log=False
        )
    except KeyboardInterrupt:
        print("\nCOACH stopped.")
