"""Configuration for the COACH web application.

All variables are optional; the server starts without any of them set.
Missing paths are reported as clear HTTP 500 errors at the point of use.

Optional:
    COACH_NUM_RECOGNISER_PATH — path to the number recogniser model
                                (nums_pca_s.pkl).  Required only for the
                                image upload endpoint; the server starts
                                without it and returns a 500 if unset when
                                a puzzle is uploaded.
    COACH_SESSIONS_DIR        — session persistence directory. Default: sessions
    COACH_HOST                — bind address. Default: 127.0.0.1
    COACH_PORT                — port. Default: 8000
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
        num_recogniser_path: Path to the number recogniser model (nums_pca_s.pkl).
            Set via COACH_NUM_RECOGNISER_PATH.  If None the upload endpoint
            returns HTTP 500 with a clear error message.
        sessions_dir: Directory for JSON session persistence files.
        host: Bind address for the uvicorn server.
        port: Port for the uvicorn server.
        mock_spec: When set, the upload endpoint bypasses InpImage and returns
            this spec directly.  Used by Playwright e2e tests.
    """

    num_recogniser_path: Path | None = dataclasses.field(
        default_factory=lambda: Path(v)
        if (v := os.environ.get("COACH_NUM_RECOGNISER_PATH"))
        else None
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
