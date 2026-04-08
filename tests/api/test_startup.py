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
            assert cfg.sessions_dir is not None
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
