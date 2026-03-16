"""Persistent status tracking for puzzle processing runs.

StatusStore reads and writes a pickle file mapping puzzle image paths to their
last known processing status ('SOLVED', 'CHEAT', 'ProcessingError: ...', etc.).
"""

import pickle
from collections.abc import ItemsView
from pathlib import Path


class StatusStore:
    """Read/write status records for puzzle images.

    Wraps a pickle file containing a dict mapping image Path to status string.
    Status values are: 'SOLVED', 'CHEAT', 'ProcessingError: ...', 'AssertionError: ...',
    'ValueError'.

    Attributes:
        _path: Path to the status pickle file.
        _data: In-memory dict mapping image path -> status string.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._data: dict[Path, str] = {}
        if path.exists():
            with open(path, "rb") as fh:
                self._data = pickle.load(fh)

    def __getitem__(self, key: Path) -> str:
        """Return the status for the given path, or empty string if not present."""
        return self._data.get(key, "")

    def __setitem__(self, key: Path, value: str) -> None:
        """Set the status for the given path."""
        self._data[key] = value

    def __contains__(self, key: object) -> bool:
        """Return True if the given path has a recorded status."""
        return key in self._data

    def save(self) -> None:
        """Persist the current status data to disk."""
        with open(self._path, "wb") as fh:
            pickle.dump(self._data, fh)

    def items(self) -> ItemsView[Path, str]:
        """Return a view of (path, status) pairs."""
        return self._data.items()

    def solved_paths(self) -> list[Path]:
        """Return paths of all puzzles with status 'SOLVED'."""
        return [p for p, s in self._data.items() if s == "SOLVED"]
