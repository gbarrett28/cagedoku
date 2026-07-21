"""API router for reading and updating coaching settings."""

from __future__ import annotations

import re

from fastapi import APIRouter

from killer_sudoku.api.schemas import CoachSettings, RuleInfo, SettingsResponse
from killer_sudoku.api.settings import SettingsStore
from killer_sudoku.solver.engine.rules import default_rules


def _display_name(rule_name: str) -> str:
    """Convert a CamelCase rule name to a space-separated display name.

    Examples: "CageCandidateFilter" -> "Cage Candidate Filter",
              "NakedSingle" -> "Naked Single".
    """
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", rule_name)


def make_settings_router(settings_store: SettingsStore) -> APIRouter:
    """Create the settings API router bound to the given settings store."""
    router = APIRouter(prefix="/api/settings", tags=["settings"])

    @router.get("", response_model=SettingsResponse)
    async def get_settings() -> SettingsResponse:
        """Return current coaching settings and the catalogue of hintable rules.

        hintable_rules lists every rule that implements HintableRule, in
        default_rules() priority order.  The frontend uses this to build the
        config modal without maintaining its own rule list.
        """
        settings = settings_store.load()
        hintable_rules = [
            RuleInfo(
                name=r.name,
                display_name=_display_name(r.name),
                description=r.description,
            )
            for r in default_rules()
        ]
        return SettingsResponse(
            always_apply_rules=settings.always_apply_rules,
            show_essential=settings.show_essential,
            hintable_rules=hintable_rules,
        )

    @router.patch("", response_model=CoachSettings)
    async def update_settings(req: CoachSettings) -> CoachSettings:
        """Replace coaching settings with the request body and persist them."""
        settings_store.save(req)
        return req

    return router
