"""Regression tests for server startup behaviour.

Verifies that the COACH app can be imported and started without any
environment variables set — a regression that was introduced when
COACH_PUZZLE_DIR became mandatory and the module-level ``app = create_app()``
call crashed on import.
"""

from __future__ import annotations

import os
import subprocess
import sys

import pytest
from starlette.testclient import TestClient

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig


def _env_without_coach() -> dict[str, str]:
    """Current environment with all COACH_* variables stripped."""
    return {k: v for k, v in os.environ.items() if not k.startswith("COACH_")}


class TestImportWithoutEnvVars:
    def test_module_importable_without_coach_env_vars(self) -> None:
        """Importing killer_sudoku.api.app must not raise even if COACH_* unset.

        Runs a subprocess so that the conftest.py setdefault calls do not
        pollute the environment.
        """
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "from killer_sudoku.api.app import serve, create_app; print('ok')",
            ],
            check=False,
            capture_output=True,
            text=True,
            env=_env_without_coach(),
        )
        assert result.returncode == 0, (
            f"Import failed without COACH_* vars:\n{result.stderr}"
        )
        assert "ok" in result.stdout

    def test_coach_config_defaults_without_env_vars(self) -> None:
        """CoachConfig() must succeed with no env vars set."""
        # Temporarily strip COACH_* from os.environ
        coach_keys = [k for k in os.environ if k.startswith("COACH_")]
        saved = {k: os.environ.pop(k) for k in coach_keys}
        try:
            cfg = CoachConfig()
            assert cfg.num_recogniser_path is None
        finally:
            os.environ.update(saved)

    def test_create_app_succeeds_without_env_vars(self) -> None:
        """create_app() must return a FastAPI app with no COACH_* vars set."""
        coach_keys = [k for k in os.environ if k.startswith("COACH_")]
        saved = {k: os.environ.pop(k) for k in coach_keys}
        try:
            app = create_app()
            assert app is not None
        finally:
            os.environ.update(saved)


class TestUploadEndpointWithoutModel:
    def test_upload_returns_500_when_model_not_configured(
        self, tmp_path: pytest.TempdirFactory
    ) -> None:
        """POST /api/puzzle/upload returns 500 with clear message if model unset."""
        cfg = CoachConfig(
            num_recogniser_path=None,
            sessions_dir=tmp_path,  # type: ignore[arg-type]
        )
        client = TestClient(create_app(cfg))

        # Minimal 1x1 JPEG
        tiny_jpg = bytes.fromhex(
            "ffd8ffe000104a464946000101000001000100"
            "00ffdb004300080606070605080707070909"
            "0808080a0a0a0c0e0e0b0d0d0d0d0d0d0d0d"
            "0c0c0e0e0c0c0d0d0c0d0d0d0d0d0d0d0d"
            "0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d"
            "0dffc0000b080001000101011100ffda0008"
            "01010000003f00f5aa00ffd9"
        )
        resp = client.post(
            "/api/puzzle",
            files={"file": ("puzzle.jpg", tiny_jpg, "image/jpeg")},
        )
        assert resp.status_code == 500
        assert "COACH_NUM_RECOGNISER_PATH" in resp.json()["detail"]
