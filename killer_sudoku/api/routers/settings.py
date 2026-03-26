"""API router for reading and updating coaching settings."""

from __future__ import annotations

from fastapi import APIRouter

from killer_sudoku.api.schemas import CoachSettings
from killer_sudoku.api.settings import SettingsStore


def make_settings_router(settings_store: SettingsStore) -> APIRouter:
    """Create the settings API router bound to the given settings store."""
    router = APIRouter(prefix="/api/settings", tags=["settings"])

    @router.get("", response_model=CoachSettings)
    async def get_settings() -> CoachSettings:
        """Return the current coaching settings."""
        return settings_store.load()

    @router.patch("", response_model=CoachSettings)
    async def update_settings(req: CoachSettings) -> CoachSettings:
        """Replace coaching settings with the request body and persist them."""
        settings_store.save(req)
        return req

    return router
