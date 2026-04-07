"""Configuration for the COACH web application.

Paths default to subdirectories of the working directory, matching the cagedoku
CLI convention (run from the project root). Override via environment variables
for deployment flexibility.
"""

from __future__ import annotations

import dataclasses
import os
from pathlib import Path

from killer_sudoku.solver.puzzle_spec import PuzzleSpec


@dataclasses.dataclass(frozen=True)
class CoachConfig:
    """Central configuration for the COACH API server.

    Attributes:
        puzzle_dir: Directory containing model files and puzzle images.
        sessions_dir: Directory for JSON session persistence files.
        host: Bind address for the uvicorn server.
        port: Port for the uvicorn server.
    """

    puzzle_dir: Path = dataclasses.field(
        default_factory=lambda: Path(os.environ.get("COACH_PUZZLE_DIR", "guardian"))
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
