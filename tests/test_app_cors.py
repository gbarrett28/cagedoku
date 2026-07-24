"""Regression test for issue #173: CORSMiddleware must not allow arbitrary origins."""

from pathlib import Path

from fastapi.testclient import TestClient

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig


def test_untrusted_origin_is_not_granted_cors_access(tmp_path: Path) -> None:
    config = CoachConfig(sessions_dir=tmp_path, host="127.0.0.1", port=8000)
    client = TestClient(create_app(config))

    response = client.options(
        "/api/quit",
        headers={
            "Origin": "http://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.headers.get("access-control-allow-origin") != "*"
    assert response.headers.get("access-control-allow-origin") != "http://evil.example"


def test_configured_origin_is_still_granted_cors_access(tmp_path: Path) -> None:
    config = CoachConfig(sessions_dir=tmp_path, host="127.0.0.1", port=8000)
    client = TestClient(create_app(config))

    response = client.options(
        "/api/quit",
        headers={
            "Origin": "http://127.0.0.1:8000",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.headers.get("access-control-allow-origin") == "http://127.0.0.1:8000"
