"""Persistent store for user coaching settings.

Settings are saved as a single JSON file alongside session files.
The file is created on first save; if it does not yet exist, default
settings are returned so no up-front I/O occurs at instantiation.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

from killer_sudoku.api.schemas import CoachSettings


@dataclasses.dataclass
class SettingsStore:
    """Persists CoachSettings as a single JSON file on disk.

    Attributes:
        settings_file: Path to the JSON settings file.
    """

    settings_file: Path

    def load(self) -> CoachSettings:
        """Return current settings, or defaults if the file does not exist."""
        if not self.settings_file.exists():
            return CoachSettings()
        return CoachSettings.model_validate_json(
            self.settings_file.read_text(encoding="utf-8")
        )

    def save(self, settings: CoachSettings) -> None:
        """Persist settings to disk, creating parent directories if needed."""
        self.settings_file.parent.mkdir(parents=True, exist_ok=True)
        self.settings_file.write_text(settings.model_dump_json(), encoding="utf-8")
