"""Persistent status tracking for puzzle processing runs.

StatusStore reads and writes a pickle file mapping puzzle image filenames to their
last known processing status ('SOLVED', 'CHEAT', 'ProcessingError: ...', etc.).

Keys are stored as plain filename strings (p.name) rather than full Path objects so
that the pickle is portable across operating systems and directory layouts.

TRAINING_STATUSES contains the set of status values whose images are eligible to be
used as training data.
"""

import pickle
from collections.abc import ItemsView
from pathlib import Path
from typing import Any

TRAINING_STATUSES: frozenset[str] = frozenset({"SOLVED", "CHEAT"})


class StatusStore:
    """Read/write status records for puzzle images.

    Wraps a pickle file containing a dict mapping image filename strings to status
    strings.  Status values are: 'SOLVED', 'CHEAT', 'ProcessingError: ...',
    'AssertionError: ...', 'ValueError'.

    Keys are stored as filename-only strings (``p.name``) for OS portability.
    The public API is still Path-based; conversions happen at the boundary via
    ``_key()``.  On first load of an old pickle whose keys are ``Path`` objects,
    the data is automatically migrated and saved.

    Attributes:
        _path: Path to the status pickle file.
        _puzzle_dir: Directory containing puzzle images; used to reconstruct Paths.
        _data: In-memory dict mapping filename string -> status string.
    """

    def __init__(self, path: Path, puzzle_dir: Path) -> None:
        self._path = path
        self._puzzle_dir = puzzle_dir
        self._data: dict[str, str] = {}
        if path.exists():
            with open(path, "rb") as fh:
                raw: Any = pickle.load(fh)
            # Migration: old pickles stored Path objects as keys.
            first_key = next(iter(raw), None)
            if first_key is not None and isinstance(first_key, Path):
                self._data = {k.name: v for k, v in raw.items()}
                self.save()
            else:
                self._data = raw

    @staticmethod
    def _key(p: Path) -> str:
        """Return the storage key for a puzzle path (filename only)."""
        return p.name

    def __getitem__(self, key: Path) -> str:
        """Return the status for the given path, or empty string if not present."""
        return self._data.get(self._key(key), "")

    def __setitem__(self, key: Path, value: str) -> None:
        """Set the status for the given path."""
        self._data[self._key(key)] = value

    def __contains__(self, key: object) -> bool:
        """Return True if the given path has a recorded status."""
        if isinstance(key, Path):
            return self._key(key) in self._data
        return False

    def save(self) -> None:
        """Persist the current status data to disk."""
        with open(self._path, "wb") as fh:
            pickle.dump(self._data, fh)

    def items(self) -> ItemsView[str, str]:
        """Return a view of (filename, status) pairs."""
        return self._data.items()

    def solved_paths(self) -> list[Path]:
        """Return paths of all puzzles with status 'SOLVED'."""
        return [self._puzzle_dir / k for k, s in self._data.items() if s == "SOLVED"]

    def training_paths(self) -> list[Path]:
        """Return paths of all puzzles whose status is in TRAINING_STATUSES."""
        return [
            self._puzzle_dir / k
            for k, s in self._data.items()
            if s in TRAINING_STATUSES
        ]
