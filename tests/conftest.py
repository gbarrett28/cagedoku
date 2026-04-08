"""Root test configuration.

Sets environment variables required by the COACH app at import time.
These are overridden in individual test fixtures that need real values.
"""

from __future__ import annotations

import os


def pytest_configure(config: object) -> None:
    """Set required COACH env vars before any app module is imported.

    The module-level ``app = create_app()`` in ``killer_sudoku.api.app``
    instantiates ``CoachConfig`` at import time, which reads these env vars.
    Setting them here (before collection begins) prevents import errors in
    test environments where the real directories do not exist.

    Uses ``os.environ.setdefault`` so that values already set in the
    environment (e.g. from CI or the developer's shell) are not overwritten.
    """
    os.environ.setdefault("COACH_PUZZLE_DIR", ".")
    os.environ.setdefault("COACH_NUM_RECOGNISER_PATH", ".")
