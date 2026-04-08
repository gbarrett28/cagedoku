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
from tests.fixtures.minimal_puzzle import (
    KNOWN_SOLUTION,
    make_trivial_spec,
    make_two_cell_cage_spec,
)

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
        cages=_spec_to_cage_states(spec),
        spec_data=_spec_to_data(spec),
        original_image_b64="dGVzdA==",  # base64("test") — placeholder for unit tests
    )


@pytest.fixture
def two_cell_state(store: SessionStore) -> PuzzleState:
    """Confirmed PuzzleState with a 2-cell cage (cells (0,0)+(0,1), total=8).

    sol_sums(2, 0, 8) = [{1,7},{2,6},{3,5}] — three valid combinations.
    """
    spec = make_two_cell_cage_spec()
    cages = _spec_to_cage_states(spec)
    state = PuzzleState(
        session_id="two-cell-001",
        cages=cages,
        spec_data=_spec_to_data(spec),
        original_image_b64="dGVzdA==",
        golden_solution=KNOWN_SOLUTION,
        user_grid=[[0] * 9 for _ in range(9)],
    )
    store.save(state)
    return state


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
# POST /api/puzzle/{session_id}/confirm — candidate state after confirm
# ---------------------------------------------------------------------------


class TestConfirmInitializesCandidates:
    def test_candidates_available_after_confirm(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        res = client.get(f"/api/puzzle/{trivial_state.session_id}/candidates")
        assert res.status_code == 200

    def test_all_user_removed_empty(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        cg = client.get(f"/api/puzzle/{trivial_state.session_id}/candidates").json()
        for r in range(9):
            for c in range(9):
                cell = cg["cells"][r][c]
                assert cell["user_removed"] == [], (
                    f"cell ({r},{c}) user_removed not empty"
                )

    def test_candidates_match_solution(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Trivial spec: every cell is a single-cell cage. After engine_solve,
        each cell's candidates contains only the solution digit."""
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        cg = client.get(f"/api/puzzle/{trivial_state.session_id}/candidates").json()
        for r in range(9):
            for c in range(9):
                cell = cg["cells"][r][c]
                expected = KNOWN_SOLUTION[r][c]
                assert cell["candidates"] == [expected], (
                    f"cell ({r},{c}): expected [{expected}], got {cell['candidates']}"
                )

    def test_must_contain_from_cage_solutions(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Trivial spec: each cage has one solution; must_contain = that solution."""
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        cg = client.get(f"/api/puzzle/{trivial_state.session_id}/candidates").json()
        for r in range(9):
            for c in range(9):
                expected = KNOWN_SOLUTION[r][c]
                # Find the cage for this cell in the cages list
                cage_for_cell = next(
                    cage for cage in cg["cages"] if [r, c] in cage["cells"]
                )
                assert expected in cage_for_cell["must_contain"], (
                    f"cell ({r},{c}): expected {expected} in must_contain"
                )


# ---------------------------------------------------------------------------
# PATCH /api/puzzle/{session_id}/cell — candidates updates
# ---------------------------------------------------------------------------


class TestCandidateWithCellEntry:
    """Candidate state is updated after /cell and restored after /undo."""

    def _confirmed_session(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> str:
        """Confirm trivial session and return session_id."""
        store.save(trivial_state)
        res = client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        assert res.status_code == 200
        return trivial_state.session_id

    def _get_cell(self, client: TestClient, sid: str, r: int, c: int) -> dict:  # type: ignore[type-arg]
        return client.get(f"/api/puzzle/{sid}/candidates").json()["cells"][r][c]

    def test_candidates_available_after_cell_entry(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        sid = self._confirmed_session(client, store, trivial_state)
        client.patch(f"/api/puzzle/{sid}/cell", json={"row": 1, "col": 1, "digit": 5})
        res = client.get(f"/api/puzzle/{sid}/candidates")
        assert res.status_code == 200

    def test_solved_cell_candidates_contain_placed_digit(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """After placing a digit, that cell's candidates still contains it."""
        sid = self._confirmed_session(client, store, trivial_state)
        digit = KNOWN_SOLUTION[0][0]
        client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": digit},
        )
        cell = self._get_cell(client, sid, 0, 0)
        assert cell["candidates"] == [digit]

    def test_undo_restores_candidate_state(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """After undo, cell (0,0) is unsolved and candidates are restored."""
        sid = self._confirmed_session(client, store, trivial_state)
        client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": KNOWN_SOLUTION[0][0]},
        )
        res = client.post(f"/api/puzzle/{sid}/undo")
        assert res.status_code == 200
        assert res.json()["user_grid"][0][0] == 0
        cell = self._get_cell(client, sid, 0, 0)
        assert KNOWN_SOLUTION[0][0] in cell["candidates"]

    def test_freeze_scope(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Place in cell A; cycle peer cell B to user_removed; undo A; assert B's
        override preserved."""
        sid = self._confirmed_session(client, store, trivial_state)
        digit_b = KNOWN_SOLUTION[0][1]
        # Cycle cell B: normal → user_removed
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 2, "digit": digit_b},
        )
        # Place digit in cell A
        client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": KNOWN_SOLUTION[0][0]},
        )
        # Undo cell A
        client.post(f"/api/puzzle/{sid}/undo")
        cell_b = self._get_cell(client, sid, 0, 1)
        assert digit_b in cell_b["user_removed"], (
            "Cell B's user_removed should still contain the digit after undoing cell A"
        )


# ---------------------------------------------------------------------------
# Rule A
# ---------------------------------------------------------------------------


class TestRuleA:
    """user_removed is preserved across cell entries and rebuilds."""

    def test_user_removed_preserved_after_cell_entry(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """user_removed entries survive a subsequent cell entry."""
        store.save(trivial_state)
        client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
        sid = trivial_state.session_id
        digit = KNOWN_SOLUTION[0][0]  # single candidate for this trivial cage
        # Cycle cell (0,0): marks digit as user_removed
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": digit},
        )
        cell_after_cycle = client.get(f"/api/puzzle/{sid}/candidates").json()["cells"][
            0
        ][0]
        assert digit in cell_after_cycle["user_removed"]
        # Place a digit in a different cell
        client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 2, "digit": KNOWN_SOLUTION[0][1]},
        )
        cell_after_entry = client.get(f"/api/puzzle/{sid}/candidates").json()["cells"][
            0
        ][0]
        assert digit in cell_after_entry["user_removed"], (
            "user_removed should be preserved after cell entry"
        )


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

    def _cell(self, client: TestClient, sid: str, r: int, c: int) -> dict:  # type: ignore[type-arg]
        return client.get(f"/api/puzzle/{sid}/candidates").json()["cells"][r][c]

    def test_cycle_adds_user_removed(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Cycling an auto-possible digit marks it user_removed."""
        sid = self._confirmed_sid(client, store, trivial_state)
        digit = KNOWN_SOLUTION[0][0]
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": digit},
        )
        assert res.status_code == 200
        cell = self._cell(client, sid, 0, 0)
        assert digit in cell["user_removed"]

    def test_cycle_twice_restores(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Cycling the same digit twice restores it (toggle)."""
        sid = self._confirmed_sid(client, store, trivial_state)
        digit = KNOWN_SOLUTION[0][0]
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": digit},
        )
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": digit},
        )
        cell = self._cell(client, sid, 0, 0)
        assert digit not in cell["user_removed"]

    def test_auto_impossible_no_op(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Cycling a digit that is auto-impossible (and not user-removed) is a
        no-op — Turn history is unchanged."""
        sid = self._confirmed_sid(client, store, trivial_state)
        history_before = store.load(sid).history
        # Digit 3 is auto-impossible for the trivial single-cell cage (total=5)
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 3},
        )
        assert res.status_code == 200
        history_after = store.load(sid).history
        assert len(history_after) == len(history_before)
        cell = self._cell(client, sid, 0, 0)
        assert cell["user_removed"] == []

    def test_reset_clears_user_removed(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """digit=0 clears user_removed for the cell."""
        sid = self._confirmed_sid(client, store, trivial_state)
        digit = KNOWN_SOLUTION[0][0]
        # Mark digit as user_removed
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": digit},
        )
        res = client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 0},
        )
        assert res.status_code == 200
        cell = self._cell(client, sid, 0, 0)
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


# ---------------------------------------------------------------------------
# GET /api/puzzle/{session_id}/cage/{label}/solutions
# ---------------------------------------------------------------------------


class TestCageSolutions:
    def test_returns_all_solutions_for_fresh_cage(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        """2-cell total-8 cage: sol_sums gives [{1,7},{2,6},{3,5}]."""
        sid = two_cell_state.session_id
        label = two_cell_state.cages[0].label
        res = client.get(f"/api/puzzle/{sid}/cage/{label}/solutions")
        assert res.status_code == 200
        body = res.json()
        assert sorted(body["all_solutions"]) == [[1, 7], [2, 6], [3, 5]]
        assert body["user_eliminated"] == []
        for s in body["auto_impossible"]:
            assert s in body["all_solutions"]

    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.get("/api/puzzle/no-such-session/cage/A/solutions")
        assert res.status_code == 404

    def test_returns_404_for_unknown_label(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        res = client.get(f"/api/puzzle/{two_cell_state.session_id}/cage/ZZZ/solutions")
        assert res.status_code == 404

    def test_returns_409_before_confirm(
        self,
        client: TestClient,
        store: SessionStore,
        trivial_state: PuzzleState,
    ) -> None:
        store.save(trivial_state)
        label = trivial_state.cages[0].label
        res = client.get(
            f"/api/puzzle/{trivial_state.session_id}/cage/{label}/solutions"
        )
        assert res.status_code == 409


# ---------------------------------------------------------------------------
# POST /api/puzzle/{session_id}/cage/{label}/solutions/eliminate
# ---------------------------------------------------------------------------


class TestEliminateSolution:
    def test_eliminate_adds_to_user_eliminated(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        sid = two_cell_state.session_id
        label = two_cell_state.cages[0].label
        res = client.post(
            f"/api/puzzle/{sid}/cage/{label}/solutions/eliminate",
            json={"solution": [3, 5]},
        )
        assert res.status_code == 200
        cage = next(c for c in res.json()["cages"] if c["label"] == label)
        assert [3, 5] in cage["user_eliminated_solns"]

    def test_eliminate_twice_restores(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        sid = two_cell_state.session_id
        label = two_cell_state.cages[0].label
        url = f"/api/puzzle/{sid}/cage/{label}/solutions/eliminate"
        client.post(url, json={"solution": [3, 5]})
        res = client.post(url, json={"solution": [3, 5]})
        assert res.status_code == 200
        cage = next(c for c in res.json()["cages"] if c["label"] == label)
        assert [3, 5] not in cage["user_eliminated_solns"]

    def test_eliminate_narrows_candidates(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        """Eliminating [3,5] from 2-cell total-8 removes 3 and 5 from candidates."""
        sid = two_cell_state.session_id
        label = two_cell_state.cages[0].label
        res = client.post(
            f"/api/puzzle/{sid}/cage/{label}/solutions/eliminate",
            json={"solution": [3, 5]},
        )
        assert res.status_code == 200
        cg = client.get(f"/api/puzzle/{sid}/candidates").json()
        assert 3 not in cg["cells"][0][0]["candidates"]
        assert 5 not in cg["cells"][0][0]["candidates"]

    def test_returns_404_unknown_session(self, client: TestClient) -> None:
        res = client.post(
            "/api/puzzle/bad/cage/A/solutions/eliminate",
            json={"solution": [1, 7]},
        )
        assert res.status_code == 404

    def test_returns_404_unknown_label(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        res = client.post(
            f"/api/puzzle/{two_cell_state.session_id}/cage/ZZZ/solutions/eliminate",
            json={"solution": [1, 7]},
        )
        assert res.status_code == 404

    def test_returns_409_before_confirm(
        self,
        client: TestClient,
        store: SessionStore,
        trivial_state: PuzzleState,
    ) -> None:
        store.save(trivial_state)
        label = trivial_state.cages[0].label
        res = client.post(
            f"/api/puzzle/{trivial_state.session_id}/cage/{label}/solutions/eliminate",
            json={"solution": [1]},
        )
        assert res.status_code == 409

    def test_returns_422_invalid_digits(
        self,
        client: TestClient,
        store: SessionStore,
        two_cell_state: PuzzleState,
    ) -> None:
        sid = two_cell_state.session_id
        label = two_cell_state.cages[0].label
        res = client.post(
            f"/api/puzzle/{sid}/cage/{label}/solutions/eliminate",
            json={"solution": [0, 10]},
        )
        assert res.status_code == 422
