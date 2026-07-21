"""JSON-backed session store for puzzle coaching state.

Each active session is stored as a single JSON file: {sessions_dir}/{session_id}.json.
Sessions survive server restarts and are deleted only by explicit cleanup.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

from killer_sudoku.api.schemas import PuzzleState


@dataclasses.dataclass
class SessionStore:
    """Persists puzzle sessions as JSON files on disk.

    The sessions directory is created on the first save, so no up-front
    file I/O occurs when the store is instantiated.

    Attributes:
        sessions_dir: Directory where session JSON files are written.
    """

    sessions_dir: Path

    def save(self, state: PuzzleState) -> None:
        """Persist a puzzle state to disk, creating the directory if needed."""
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        path = self.sessions_dir / f"{state.session_id}.json"
        path.write_text(state.model_dump_json(), encoding="utf-8")

    def load(self, session_id: str) -> PuzzleState:
        """Load a puzzle state from disk.

        Raises:
            KeyError: if no session with the given ID exists.
        """
        path = self.sessions_dir / f"{session_id}.json"
        if not path.exists():
            raise KeyError(f"Session {session_id!r} not found")
        return PuzzleState.model_validate_json(path.read_text(encoding="utf-8"))

    def exists(self, session_id: str) -> bool:
        """Return True if a session file for the given ID exists on disk."""
        return (self.sessions_dir / f"{session_id}.json").exists()
