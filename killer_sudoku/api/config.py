"""Configuration for the COACH web application.

Paths are set via environment variables.  The server fails to start if a
required variable is unset.  Override optional variables for deployment
flexibility.

Required:
    COACH_PUZZLE_DIR          — directory containing puzzle images and cached
                                .jpk files.

Optional:
    COACH_NUM_RECOGNISER_PATH — path to the number recogniser model
                                (nums_pca_s.pkl).  Must be set explicitly;
                                no default path is assumed.
    COACH_SESSIONS_DIR        — session persistence directory. Default: sessions
    COACH_HOST                — bind address. Default: 127.0.0.1
    COACH_PORT                — port. Default: 8000
"""

from __future__ import annotations

import dataclasses
import os
from pathlib import Path

from killer_sudoku.solver.puzzle_spec import PuzzleSpec


def _require_env(var: str) -> Path:
    """Return Path(os.environ[var]), raising ValueError if unset."""
    v = os.environ.get(var)
    if v is None:
        raise ValueError(
            f"{var} environment variable must be set. "
            f"Point it to the directory containing puzzle images."
        )
    return Path(v)


@dataclasses.dataclass(frozen=True)
class CoachConfig:
    """Central configuration for the COACH API server.

    Attributes:
        puzzle_dir: Directory containing puzzle images and cached .jpk files.
            Set via COACH_PUZZLE_DIR — no default; the server raises at startup
            if unset.
        num_recogniser_path: Path to the number recogniser model (nums_pca_s.pkl).
            Set via COACH_NUM_RECOGNISER_PATH — required; no default is assumed.
        sessions_dir: Directory for JSON session persistence files.
        host: Bind address for the uvicorn server.
        port: Port for the uvicorn server.
    """

    puzzle_dir: Path = dataclasses.field(
        default_factory=lambda: _require_env("COACH_PUZZLE_DIR")
    )
    num_recogniser_path: Path = dataclasses.field(
        default_factory=lambda: _require_env("COACH_NUM_RECOGNISER_PATH")
    )
    sessions_dir: Path = dataclasses.field(
        default_factory=lambda: Path(os.environ.get("COACH_SESSIONS_DIR", "sessions"))
    )
    host: str = dataclasses.field(
        default_factory=lambda: os.environ.get("COACH_HOST", "127.0.0.1")
    )
    port: int = dataclasses.field(
        default_factory=lambda: int(os.environ.get("COACH_PORT", "8000"))
    )
    mock_spec: PuzzleSpec | None = dataclasses.field(default=None)
    # When set, the upload endpoint bypasses InpImage and returns this spec
    # directly. Used by Playwright e2e tests via CoachConfig(mock_spec=...).

    @property
    def settings_file(self) -> Path:
        """Path to the persistent coaching settings JSON file."""
        return self.sessions_dir / "settings.json"
