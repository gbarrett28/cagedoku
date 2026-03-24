"""Integration tests for the COACH puzzle API endpoints.

Uses FastAPI's TestClient with a CoachConfig pointing at a tmp_path sessions
directory. Sessions are pre-seeded directly via SessionStore so the upload
endpoint (which requires real model files) is exercised separately.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig
from killer_sudoku.api.routers.puzzle import (
    _spec_to_cage_states,
    _spec_to_data,
)
from killer_sudoku.api.schemas import PuzzleState
from killer_sudoku.api.session import SessionStore
from tests.fixtures.minimal_puzzle import KNOWN_SOLUTION, make_trivial_spec

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def sessions_dir(tmp_path: Path) -> Path:
    return tmp_path / "sessions"


@pytest.fixture
def store(sessions_dir: Path) -> SessionStore:
    return SessionStore(sessions_dir)


@pytest.fixture
def client(sessions_dir: Path, tmp_path: Path) -> TestClient:
    """TestClient backed by a test app whose sessions_dir is the tmp_path."""
    config = CoachConfig(
        guardian_dir=tmp_path / "guardian",
        observer_dir=tmp_path / "observer",
        sessions_dir=sessions_dir,
    )
    return TestClient(create_app(config))


@pytest.fixture
def trivial_state() -> PuzzleState:
    """A fully populated PuzzleState derived from the trivial single-cell-cage
    puzzle."""
    spec = make_trivial_spec()
    return PuzzleState(
        session_id="trivial-session-001",
        newspaper="guardian",
        cages=_spec_to_cage_states(spec),
        spec_data=_spec_to_data(spec),
        original_image_b64="dGVzdA==",  # base64("test") — placeholder for unit tests
    )


# ---------------------------------------------------------------------------
# GET /api/puzzle/{session_id}
# ---------------------------------------------------------------------------


class TestGetPuzzle:
    def test_returns_200_for_known_session(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.get(f"/api/puzzle/{trivial_state.session_id}")
        assert res.status_code == 200

    def test_response_contains_session_id(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        body = client.get(f"/api/puzzle/{trivial_state.session_id}").json()
        assert body["session_id"] == trivial_state.session_id

    def test_response_contains_cages(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        body = client.get(f"/api/puzzle/{trivial_state.session_id}").json()
        assert len(body["cages"]) == 81

    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.get("/api/puzzle/does-not-exist")
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /api/puzzle/{session_id}/cage/{label}
# ---------------------------------------------------------------------------


class TestPatchCage:
    def test_returns_200_on_valid_edit(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        first_label = trivial_state.cages[0].label
        res = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cage/{first_label}",
            json={"total": 42},
        )
        assert res.status_code == 200

    def test_total_updated_in_response(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        first_label = trivial_state.cages[0].label
        body = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cage/{first_label}",
            json={"total": 42},
        ).json()
        updated = next(c for c in body["cages"] if c["label"] == first_label)
        assert updated["total"] == 42

    def test_total_updated_in_persisted_session(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        first_label = trivial_state.cages[0].label
        client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cage/{first_label}",
            json={"total": 77},
        )
        saved = store.load(trivial_state.session_id)
        assert next(c for c in saved.cages if c.label == first_label).total == 77

    def test_other_cages_unchanged_after_edit(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        first_label = trivial_state.cages[0].label
        second_label = trivial_state.cages[1].label
        original_second_total = trivial_state.cages[1].total

        body = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cage/{first_label}",
            json={"total": 42},
        ).json()
        second_after = next(c for c in body["cages"] if c["label"] == second_label)
        assert second_after["total"] == original_second_total

    def test_original_image_preserved_in_response(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        first_label = trivial_state.cages[0].label
        body = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cage/{first_label}",
            json={"total": 5},
        ).json()
        assert body["original_image_b64"] == trivial_state.original_image_b64

    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.patch("/api/puzzle/bad-session/cage/A", json={"total": 5})
        assert res.status_code == 404

    def test_returns_404_for_unknown_cage_label(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cage/ZZZ",
            json={"total": 5},
        )
        assert res.status_code == 404

    def test_label_matching_is_case_insensitive(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        first_label = trivial_state.cages[0].label.lower()
        res = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cage/{first_label}",
            json={"total": 42},
        )
        assert res.status_code == 200

    def test_playing_mode_fields_survive_cage_edit(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Editing a cage total must not wipe out playing-mode fields."""
        playing = trivial_state.model_copy(
            update={
                "user_grid": [[0] * 9 for _ in range(9)],
                "golden_solution": [[1] * 9 for _ in range(9)],
                "move_history": [],
            }
        )
        store.save(playing)
        first_label = playing.cages[0].label
        res = client.patch(
            f"/api/puzzle/{playing.session_id}/cage/{first_label}",
            json={"total": 7},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["user_grid"] is not None
        assert body["golden_solution"] is not None


# ---------------------------------------------------------------------------
# POST /api/puzzle/{session_id}/solve
# ---------------------------------------------------------------------------


class TestSolvePuzzle:
    def test_returns_200(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/solve")
        assert res.status_code == 200

    def test_solved_flag_true(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        body = client.post(f"/api/puzzle/{trivial_state.session_id}/solve").json()
        assert body["solved"] is True

    def test_solution_grid_is_9x9(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        body = client.post(f"/api/puzzle/{trivial_state.session_id}/solve").json()
        grid = body["grid"]
        assert len(grid) == 9
        assert all(len(row) == 9 for row in grid)

    def test_solution_matches_known_solution(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        # The trivial puzzle uniquely constrains every cell — solution must be
        # KNOWN_SOLUTION
        store.save(trivial_state)
        body = client.post(f"/api/puzzle/{trivial_state.session_id}/solve").json()
        assert body["grid"] == KNOWN_SOLUTION

    def test_solution_digits_are_1_to_9(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        body = client.post(f"/api/puzzle/{trivial_state.session_id}/solve").json()
        digits = [d for row in body["grid"] for d in row]
        assert all(1 <= d <= 9 for d in digits)

    def test_no_error_field_on_success(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        body = client.post(f"/api/puzzle/{trivial_state.session_id}/solve").json()
        assert body["error"] is None

    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.post("/api/puzzle/no-such-session/solve")
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/puzzle/{session_id}/cage/{label}/subdivide
# ---------------------------------------------------------------------------


class TestSubdivideCage:
    def test_returns_200(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        first_label = trivial_state.cages[0].label
        first_cell = trivial_state.cages[0].cells[0]
        res = client.post(
            f"/api/puzzle/{trivial_state.session_id}/cage/{first_label}/subdivide",
            json={
                "sub_cages": [
                    {
                        "label": f"{first_label}1",
                        "total": None,
                        "cells": [first_cell.model_dump()],
                    }
                ]
            },
        )
        assert res.status_code == 200

    def test_subdivision_stored_in_session(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        first_label = trivial_state.cages[0].label
        first_cell = trivial_state.cages[0].cells[0]
        client.post(
            f"/api/puzzle/{trivial_state.session_id}/cage/{first_label}/subdivide",
            json={
                "sub_cages": [
                    {
                        "label": f"{first_label}1",
                        "total": 5,
                        "cells": [first_cell.model_dump()],
                    }
                ]
            },
        )
        saved = store.load(trivial_state.session_id)
        cage = next(c for c in saved.cages if c.label == first_label)
        assert len(cage.subdivisions) == 1
        assert cage.subdivisions[0].label == f"{first_label}1"

    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.post(
            "/api/puzzle/no-such/cage/A/subdivide",
            json={"sub_cages": []},
        )
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /api/puzzle/{session_id}/cell
# ---------------------------------------------------------------------------


class TestCellEntry:
    def _confirm(self, client: TestClient, session_id: str) -> None:
        client.post(f"/api/puzzle/{session_id}/confirm")

    def test_digit_stored_in_user_grid(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        self._confirm(client, trivial_state.session_id)
        res = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        assert res.status_code == 200
        assert res.json()["user_grid"][0][0] == 5

    def test_move_record_appended_with_prev_digit(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        self._confirm(client, trivial_state.session_id)
        res = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": 2, "col": 3, "digit": 7},
        )
        history = res.json()["move_history"]
        assert len(history) == 1
        assert history[0] == {"row": 2, "col": 3, "digit": 7, "prev_digit": 0}

    def test_prev_digit_recorded_on_overwrite(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        self._confirm(client, trivial_state.session_id)
        client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        res = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        history = res.json()["move_history"]
        assert history[-1]["prev_digit"] == 5

    def test_clear_sets_cell_to_zero_and_records_prev(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        self._confirm(client, trivial_state.session_id)
        client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        res = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": 1, "col": 1, "digit": 0},
        )
        body = res.json()
        assert body["user_grid"][0][0] == 0
        assert body["move_history"][-1]["digit"] == 0
        assert body["move_history"][-1]["prev_digit"] == 5

    def test_returns_409_on_unconfirmed_session(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        assert res.status_code == 409

    def test_returns_422_on_invalid_row(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        self._confirm(client, trivial_state.session_id)
        res = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": 10, "col": 1, "digit": 5},
        )
        assert res.status_code == 422


# ---------------------------------------------------------------------------
# POST /api/puzzle/{session_id}/undo
# ---------------------------------------------------------------------------


class TestUndo:
    def _setup_with_move(
        self,
        client: TestClient,
        store: SessionStore,
        trivial_state: PuzzleState,
        row: int = 1,
        col: int = 1,
        digit: int = 5,
    ) -> None:
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": row, "col": col, "digit": digit},
        )

    def test_undo_restores_prev_digit(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        self._setup_with_move(client, store, trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/undo")
        assert res.status_code == 200
        assert res.json()["user_grid"][0][0] == 0

    def test_undo_removes_move_from_history(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        self._setup_with_move(client, store, trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/undo")
        assert res.json()["move_history"] == []

    def test_undo_of_overwrite_restores_previous_digit(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        client.patch(
            f"/api/puzzle/{trivial_state.session_id}/cell",
            json={"row": 1, "col": 1, "digit": 9},
        )
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/undo")
        assert res.json()["user_grid"][0][0] == 5

    def test_returns_409_on_empty_history(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/undo")
        assert res.status_code == 409

    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.post("/api/puzzle/no-such-session/undo")
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/puzzle/{session_id}/confirm
# ---------------------------------------------------------------------------


class TestConfirm:
    def test_returns_200_with_user_grid_all_zeros(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        assert res.status_code == 200
        body = res.json()
        assert body["user_grid"] is not None
        assert len(body["user_grid"]) == 9
        assert all(len(row) == 9 for row in body["user_grid"])
        assert all(cell == 0 for row in body["user_grid"] for cell in row)

    def test_golden_solution_matches_known_solution(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        body = res.json()
        assert body["golden_solution"] == KNOWN_SOLUTION

    def test_returns_409_on_already_confirmed_session(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        assert res.status_code == 409

    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.post("/api/puzzle/no-such-session/confirm")
        assert res.status_code == 404

    def test_returns_422_for_invalid_cage_layout(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Solver raises on an invalid layout — endpoint must return 422."""
        corrupted_cages = [
            cage.model_copy(update={"total": 0}) for cage in trivial_state.cages
        ]
        bad_state = trivial_state.model_copy(update={"cages": corrupted_cages})
        store.save(bad_state)
        res = client.post(f"/api/puzzle/{bad_state.session_id}/confirm")
        assert res.status_code == 422


# ---------------------------------------------------------------------------
# POST /api/puzzle/{session_id}/confirm — candidate_grid initialisation
# ---------------------------------------------------------------------------


class TestConfirmInitializesCandidates:
    def test_candidate_grid_is_not_none(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        assert res.status_code == 200
        data = res.json()
        assert data["candidate_grid"] is not None

    def test_mode_is_auto(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        cg = res.json()["candidate_grid"]
        assert cg["mode"] == "auto"

    def test_all_overrides_empty(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        cg = res.json()["candidate_grid"]
        for r in range(9):
            for c in range(9):
                cell = cg["cells"][r][c]
                assert cell["user_essential"] == [], (
                    f"cell ({r},{c}) user_essential not empty"
                )
                assert cell["user_removed"] == [], (
                    f"cell ({r},{c}) user_removed not empty"
                )

    def test_auto_candidates_match_solution(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Trivial spec: every cell is a single-cell cage. After engine_solve,
        each cell's auto_candidates equals its solution digit."""
        store.save(trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        cg = res.json()["candidate_grid"]
        for r in range(9):
            for c in range(9):
                cell = cg["cells"][r][c]
                expected = KNOWN_SOLUTION[r][c]
                assert cell["auto_candidates"] == [expected], (
                    f"cell ({r},{c}): expected [{expected}],"
                    f" got {cell['auto_candidates']}"
                )
                assert cell["auto_essential"] == [expected], (
                    f"cell ({r},{c}): expected essential [{expected}],"
                    f" got {cell['auto_essential']}"
                )


# ---------------------------------------------------------------------------
# PATCH /api/puzzle/{session_id}/cell — candidate_grid updates
# ---------------------------------------------------------------------------


class TestCandidateWithCellEntry:
    """candidate_grid is updated after /cell and restored after /undo.

    Freeze rule: solved cell's CandidateCell is unchanged during recomputation.
    """

    def _confirmed_session(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> str:
        """Confirm trivial session and return session_id."""
        store.save(trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        assert res.status_code == 200
        return trivial_state.session_id

    def test_candidate_grid_updated_after_cell_entry(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        sid = self._confirmed_session(client, store, trivial_state)
        res = client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        assert res.status_code == 200
        cg = res.json()["candidate_grid"]
        assert cg is not None

    def test_solved_cell_candidates_frozen(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """After placing a digit, that cell's CandidateCell is frozen unchanged."""
        sid = self._confirmed_session(client, store, trivial_state)
        state_before = store.load(sid)
        assert state_before.candidate_grid is not None
        cell_before = state_before.candidate_grid.cells[0][0]

        res = client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": KNOWN_SOLUTION[0][0]},
        )
        assert res.status_code == 200
        cg_after = res.json()["candidate_grid"]
        cell_after = cg_after["cells"][0][0]
        assert cell_after["auto_candidates"] == cell_before.auto_candidates
        assert cell_after["auto_essential"] == cell_before.auto_essential

    def test_undo_restores_candidate_state(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """After undo, candidate_grid is non-None and cell (0,0) is unsolved again."""
        sid = self._confirmed_session(client, store, trivial_state)
        client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": KNOWN_SOLUTION[0][0]},
        )
        res = client.post(f"/api/puzzle/{sid}/undo")
        assert res.status_code == 200
        state = res.json()
        assert state["user_grid"][0][0] == 0
        assert state["candidate_grid"] is not None
        cell = state["candidate_grid"]["cells"][0][0]
        assert KNOWN_SOLUTION[0][0] in cell["auto_candidates"]

    def test_freeze_scope(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Place in cell A; cycle peer cell B; undo A; assert B's override preserved."""
        sid = self._confirmed_session(client, store, trivial_state)
        # Switch to manual so we can cycle any digit in peer cell B = (0,1)
        client.post(
            f"/api/puzzle/{sid}/candidates/mode",
            json={"mode": "manual"},
        )
        # Cycle digit 7 in cell B (0,1) [row=1, col=2]: inessential → essential
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 2, "digit": 7},
        )
        # Place digit in cell A = (0,0)
        client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": KNOWN_SOLUTION[0][0]},
        )
        # Undo
        res = client.post(f"/api/puzzle/{sid}/undo")
        data = res.json()
        cell_b = data["candidate_grid"]["cells"][0][1]
        assert 7 in cell_b["user_essential"], (
            "Cell B's user_essential should still have 7 after undoing cell A"
        )


# ---------------------------------------------------------------------------
# Rule A
# ---------------------------------------------------------------------------


class TestRuleA:
    """Rule A: digits dropped from auto_candidates are removed from user_essential."""

    def test_rule_a_removes_from_user_essential(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """After confirming, manually promote a digit in cell (0,1).
        Then switch to auto — Rule A removes any digit not in auto_candidates."""
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        sid = trivial_state.session_id
        # Switch to manual
        client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
        # In manual mode, cycle digit 3 in cell (0,0): inessential → essential
        # (digit 3 is NOT in auto_candidates for (0,0), which has auto_candidates=[5])
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        # Switch to auto: digit 3 not in auto_candidates → cleared from user_essential
        res = client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "auto"})
        data = res.json()
        cell_00 = data["candidate_grid"]["cells"][0][0]
        assert 3 not in cell_00["user_essential"], (
            "Rule A: digit 3 should be removed from user_essential"
            " since auto says impossible"
        )

    def test_user_removed_preserved_when_auto_also_impossible(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """user_removed entries are preserved even when auto also considers digit
        impossible."""
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        sid = trivial_state.session_id
        # In auto mode: cycle digit 5 in cell (0,0) [row=1,col=1]
        # Digit 5 is auto-essential → first cycle sends it to impossible (user_removed)
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        cell = res.json()["candidate_grid"]["cells"][0][0]
        assert 5 in cell["user_removed"]
        # Place a digit in the same row (cell entry should preserve user_removed)
        res2 = client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 2, "digit": KNOWN_SOLUTION[0][1]},
        )
        cell_after = res2.json()["candidate_grid"]["cells"][0][0]
        assert 5 in cell_after["user_removed"], (
            "user_removed should be preserved after cell entry"
        )


# ---------------------------------------------------------------------------
# POST /api/puzzle/{session_id}/candidates/mode
# ---------------------------------------------------------------------------


class TestCandidateMode:
    def _confirmed_sid(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> str:
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        return trivial_state.session_id

    def test_auto_to_manual_preserves_cells(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        sid = self._confirmed_sid(client, store, trivial_state)
        before = store.load(sid)
        assert before.candidate_grid is not None
        res = client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
        assert res.status_code == 200
        data = res.json()
        assert data["candidate_grid"]["mode"] == "manual"
        cg = before.candidate_grid
        assert data["candidate_grid"]["cells"] == [
            [
                {
                    "auto_candidates": cg.cells[r][c].auto_candidates,
                    "auto_essential": cg.cells[r][c].auto_essential,
                    "user_essential": cg.cells[r][c].user_essential,
                    "user_removed": cg.cells[r][c].user_removed,
                }
                for c in range(9)
            ]
            for r in range(9)
        ]

    def test_manual_to_auto_user_removed_stays(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """User-removed digit that auto says possible stays in user_removed."""
        sid = self._confirmed_sid(client, store, trivial_state)
        client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
        # In manual mode, cycle digit 5 in cell (0,0):
        # inessential → essential → impossible
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        # Now cell (0,0) has digit 5 in user_removed
        res = client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "auto"})
        assert res.status_code == 200
        cell = res.json()["candidate_grid"]["cells"][0][0]
        # In trivial spec auto_candidates for (0,0) = [5], so auto says possible
        # user_removed [5] should stay (more restrictive wins)
        assert 5 in cell["user_removed"]

    def test_manual_to_auto_rule_a_clears_user_essential(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Digit auto says impossible is cleared from user_essential on merge."""
        sid = self._confirmed_sid(client, store, trivial_state)
        client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
        # In manual mode, cycle digit 3 in cell (0,0): inessential→essential
        # (digit 3 is NOT in auto_candidates for (0,0), which has auto_candidates=[5])
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        # Switch to auto: digit 3 not in auto_candidates → cleared from user_essential
        res = client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "auto"})
        assert res.status_code == 200
        cell = res.json()["candidate_grid"]["cells"][0][0]
        assert 3 not in cell["user_essential"]

    def test_409_if_not_confirmed(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.post(
            f"/api/puzzle/{trivial_state.session_id}/candidates/mode",
            json={"mode": "manual"},
        )
        assert res.status_code == 409


# ---------------------------------------------------------------------------
# PATCH /api/puzzle/{session_id}/candidates/cell
# ---------------------------------------------------------------------------


class TestCandidateCycle:
    """Tests for PATCH /candidates/cell cycle behavior."""

    def _confirmed_sid(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> str:
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        return trivial_state.session_id

    def test_manual_inessential_to_essential(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        sid = self._confirmed_sid(client, store, trivial_state)
        client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        assert res.status_code == 200
        cell = res.json()["candidate_grid"]["cells"][0][0]
        assert 3 in cell["user_essential"]
        assert 3 not in cell["user_removed"]

    def test_manual_essential_to_impossible(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        sid = self._confirmed_sid(client, store, trivial_state)
        client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        assert res.status_code == 200
        cell = res.json()["candidate_grid"]["cells"][0][0]
        assert 3 not in cell["user_essential"]
        assert 3 in cell["user_removed"]

    def test_manual_impossible_to_inessential(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        sid = self._confirmed_sid(client, store, trivial_state)
        client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        cell = res.json()["candidate_grid"]["cells"][0][0]
        assert 3 not in cell["user_essential"]
        assert 3 not in cell["user_removed"]

    def test_auto_essential_to_impossible(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Auto-essential digit: cycles essential → impossible (user_removed)."""
        sid = self._confirmed_sid(client, store, trivial_state)
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        assert res.status_code == 200
        cell = res.json()["candidate_grid"]["cells"][0][0]
        assert 5 in cell["user_removed"]
        assert 5 not in cell["user_essential"]

    def test_auto_impossible_to_essential(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """After making auto-essential impossible, next cycle restores it."""
        sid = self._confirmed_sid(client, store, trivial_state)
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        cell = res.json()["candidate_grid"]["cells"][0][0]
        assert 5 not in cell["user_removed"]
        assert 5 not in cell["user_essential"]  # auto-essential, not user-essential

    def test_auto_impossible_no_op(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Cycling a digit that auto says impossible (and not user-removed) is a
        no-op."""
        sid = self._confirmed_sid(client, store, trivial_state)
        before = store.load(sid)
        assert before.candidate_grid is not None
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        assert res.status_code == 200
        after = res.json()["candidate_grid"]["cells"][0][0]
        assert after["user_essential"] == []
        assert after["user_removed"] == []

    def test_reset_clears_overrides(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """digit=0 clears user_essential and user_removed for the cell."""
        sid = self._confirmed_sid(client, store, trivial_state)
        client.post(f"/api/puzzle/{sid}/candidates/mode", json={"mode": "manual"})
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 0},
        )
        assert res.status_code == 200
        cell = res.json()["candidate_grid"]["cells"][0][0]
        assert cell["user_essential"] == []
        assert cell["user_removed"] == []

    def test_409_if_not_confirmed(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        res = client.patch(
            f"/api/puzzle/{trivial_state.session_id}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        assert res.status_code == 409
