"""Configuration for the COACH web application.

Paths default to subdirectories of the working directory, matching the cagedoku
CLI convention (run from the project root). Override via environment variables
for deployment flexibility.
"""

from __future__ import annotations

import dataclasses
import os
from pathlib import Path
from typing import Literal

from killer_sudoku.solver.puzzle_spec import PuzzleSpec


@dataclasses.dataclass(frozen=True)
class CoachConfig:
    """Central configuration for the COACH API server.

    Attributes:
        guardian_dir: Directory containing Guardian model files and puzzle images.
        observer_dir: Directory containing Observer model files and puzzle images.
        sessions_dir: Directory for JSON session persistence files.
        host: Bind address for the uvicorn server.
        port: Port for the uvicorn server.
    """

    guardian_dir: Path = dataclasses.field(
        default_factory=lambda: Path(os.environ.get("COACH_GUARDIAN_DIR", "guardian"))
    )
    observer_dir: Path = dataclasses.field(
        default_factory=lambda: Path(os.environ.get("COACH_OBSERVER_DIR", "observer"))
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

    def puzzle_dir(self, newspaper: Literal["guardian", "observer"]) -> Path:
        """Return the model/puzzle directory for the given newspaper source."""
        return self.guardian_dir if newspaper == "guardian" else self.observer_dir
