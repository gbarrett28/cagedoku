"""Playwright e2e test fixtures.

Starts the COACH server in a background thread using the trivial puzzle
fixture (mock_ocr via CoachConfig.mock_spec). The server runs on localhost
at a fixed port for the duration of the test session.
"""

from __future__ import annotations

import base64
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig
from tests.fixtures.candidates_puzzle import make_candidates_spec

_E2E_PORT = 9878
_E2E_HOST = "127.0.0.1"

# 1×1 white JPEG — generated with:
# cv2.imencode(".jpg", np.zeros((1,1,3), np.uint8)+255)[1]
_TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYF"
    "BgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoK"
    "CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAABAAEDASIAAhEB"
    "AxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9"
    "AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6"
    "Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ip"
    "qrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEB"
    "AQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdh"
    "cRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldY"
    "WVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE"
    "xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9/KKKKAP/2Q=="
)


@pytest.fixture(scope="session")
def live_server_url(tmp_path_factory: pytest.TempPathFactory) -> str:
    """Start COACH server with mock_spec; return its base URL."""
    sessions_dir = tmp_path_factory.mktemp("e2e_sessions")
    config = CoachConfig(
        puzzle_dir=Path("."),
        sessions_dir=sessions_dir,
        host=_E2E_HOST,
        port=_E2E_PORT,
        mock_spec=make_candidates_spec(),
    )
    app = create_app(config)
    server = uvicorn.Server(
        uvicorn.Config(app, host=_E2E_HOST, port=_E2E_PORT, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    # Poll until server accepts connections
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        try:
            httpx.get(f"http://{_E2E_HOST}:{_E2E_PORT}/")
            break
        except httpx.ConnectError:
            time.sleep(0.05)
    else:
        raise RuntimeError("COACH e2e server did not start within 10 seconds")

    return f"http://{_E2E_HOST}:{_E2E_PORT}"


@pytest.fixture(scope="session")
def tiny_jpeg_bytes() -> bytes:
    """Return a minimal valid JPEG as bytes (1×1 white pixel)."""
    return base64.b64decode(_TINY_JPEG_B64)
