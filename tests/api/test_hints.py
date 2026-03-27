"""Tests for the hints and hints/apply endpoints on Guardian puzzle 10.

Tests verify the full hint → apply cycle end-to-end through the HTTP API:
  1. GET /{session_id}/hints returns the expected rules.
  2. POST /{session_id}/hints/apply records eliminations as user_removed.
  3. Eliminated digits are absent from the returned candidate grid.
  4. Re-fetching GET /{session_id}/hints after applying one hint surfaces
     downstream hints that required the prior elimination.

Guardian puzzle 10 structural context (0-based coordinates):
  Cage D  cells (0,5),(0,6),(0,7),(1,7) — total 30, solution {6,7,8,9}.
  MustContainOutie fires: eliminate 7 from (1,7) / r2c8.
  After that elimination CageConfinement fires:
    n=1  d=7  confined to row 0 → eliminate 7 from other row-0 cells outside D.
    n=2  d=6/8/9  cages B+D confined to rows 0+1 → eliminate from those rows.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig
from killer_sudoku.api.routers.puzzle import (
    _compute_candidate_grid,
    _spec_to_cage_states,
    _spec_to_data,
)
from killer_sudoku.api.schemas import DEFAULT_ALWAYS_APPLY_RULES, PuzzleState
from killer_sudoku.api.session import SessionStore
from tests.fixtures.guardian10_puzzle import make_guardian10_spec

# ---------------------------------------------------------------------------
# Guardian 10 golden solution (full solve).
# ---------------------------------------------------------------------------

GUARDIAN10_SOLUTION: list[list[int]] = [
    [3, 5, 8, 4, 2, 6, 7, 9, 1],
    [7, 4, 6, 9, 3, 1, 2, 8, 5],
    [2, 9, 1, 5, 8, 7, 4, 3, 6],
    [9, 8, 3, 6, 1, 2, 5, 4, 7],
    [6, 2, 4, 7, 5, 9, 3, 1, 8],
    [5, 1, 7, 8, 4, 3, 6, 2, 9],
    [1, 6, 9, 2, 7, 4, 8, 5, 3],
    [8, 3, 2, 1, 6, 5, 9, 7, 4],
    [4, 7, 5, 3, 9, 8, 1, 6, 2],
]


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
    config = CoachConfig(
        guardian_dir=tmp_path / "guardian",
        observer_dir=tmp_path / "observer",
        sessions_dir=sessions_dir,
    )
    return TestClient(create_app(config))


@pytest.fixture
def g10_state(store: SessionStore) -> PuzzleState:
    """Confirmed PuzzleState for Guardian puzzle 10, seeded into the store."""
    spec = make_guardian10_spec()
    cages = _spec_to_cage_states(spec)
    state = PuzzleState(
        session_id="guardian10-test-001",
        newspaper="guardian",
        cages=cages,
        spec_data=_spec_to_data(spec),
        original_image_b64="dGVzdA==",
        golden_solution=GUARDIAN10_SOLUTION,
        user_grid=[[0] * 9 for _ in range(9)],
    )
    cg = _compute_candidate_grid(state, None, frozenset(DEFAULT_ALWAYS_APPLY_RULES))
    state = state.model_copy(update={"candidate_grid": cg})
    store.save(state)
    return state


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _get_hints(client: TestClient, session_id: str) -> list[dict]:  # type: ignore[type-arg]
    resp = client.get(f"/api/puzzle/{session_id}/hints")
    assert resp.status_code == 200, resp.text
    return resp.json()["hints"]  # type: ignore[no-any-return]


def _apply_hint(
    client: TestClient,
    session_id: str,
    eliminations: list[dict],  # type: ignore[type-arg]
) -> dict:  # type: ignore[type-arg]
    resp = client.post(
        f"/api/puzzle/{session_id}/hints/apply",
        json={"eliminations": eliminations},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()  # type: ignore[no-any-return]


def _make_g10_state(store: SessionStore) -> tuple[str, PuzzleState]:
    """Seed a confirmed guardian-10 state into store; return (session_id, state).

    Extracted from the g10_state fixture so other test modules can reuse it
    without depending on pytest fixture injection.
    """
    spec = make_guardian10_spec()
    sid = str(uuid.uuid4())
    state = PuzzleState(
        session_id=sid,
        newspaper="guardian",
        cages=_spec_to_cage_states(spec),
        spec_data=_spec_to_data(spec),
        original_image_b64="dGVzdA==",
        user_grid=[[0] * 9 for _ in range(9)],
    )
    store.save(state)
    return sid, state


# ---------------------------------------------------------------------------
# Tests: GET /hints
# ---------------------------------------------------------------------------


class TestGetHints:
    def test_returns_200(self, client: TestClient, g10_state: PuzzleState) -> None:
        resp = client.get(f"/api/puzzle/{g10_state.session_id}/hints")
        assert resp.status_code == 200

    def test_must_contain_outie_hint_present(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        hints = _get_hints(client, g10_state.session_id)
        rule_names = [h["rule_name"] for h in hints]
        assert "MustContainOutie" in rule_names

    def test_must_contain_outie_eliminates_7_from_r2c8(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        hints = _get_hints(client, g10_state.session_id)
        mco = next(h for h in hints if h["rule_name"] == "MustContainOutie")
        # r2c8 is (row=1, col=7) in 0-based coordinates
        assert {"cell": [1, 7], "digit": 7} in mco["eliminations"]

    def test_404_for_unknown_session(self, client: TestClient) -> None:
        resp = client.get("/api/puzzle/nonexistent/hints")
        assert resp.status_code == 404

    def test_empty_hints_before_confirm(
        self, client: TestClient, store: SessionStore
    ) -> None:
        """Hints endpoint returns an empty list before /confirm (no user_grid yet)."""
        spec = make_guardian10_spec()
        unconfirmed = PuzzleState(
            session_id="g10-unconfirmed",
            newspaper="guardian",
            cages=_spec_to_cage_states(spec),
            spec_data=_spec_to_data(spec),
            original_image_b64="dGVzdA==",
        )
        store.save(unconfirmed)
        resp = client.get(f"/api/puzzle/{unconfirmed.session_id}/hints")
        assert resp.status_code == 200
        assert resp.json()["hints"] == []


# ---------------------------------------------------------------------------
# Tests: POST /hints/apply — MustContainOutie
# ---------------------------------------------------------------------------


class TestApplyMustContainOutie:
    def test_returns_200(self, client: TestClient, g10_state: PuzzleState) -> None:
        hints = _get_hints(client, g10_state.session_id)
        mco = next(h for h in hints if h["rule_name"] == "MustContainOutie")
        resp = client.post(
            f"/api/puzzle/{g10_state.session_id}/hints/apply",
            json={"eliminations": mco["eliminations"]},
        )
        assert resp.status_code == 200

    def test_digit_7_marked_user_removed_in_r2c8(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        hints = _get_hints(client, g10_state.session_id)
        mco = next(h for h in hints if h["rule_name"] == "MustContainOutie")
        state = _apply_hint(client, g10_state.session_id, mco["eliminations"])

        cg = state["candidate_grid"]
        r2c8 = cg["cells"][1][7]  # 0-based (row=1, col=7)
        assert 7 in r2c8["user_removed"]

    def test_digit_7_still_in_auto_candidates_of_r2c8(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        """user_removed does not retroactively shrink auto_candidates."""
        hints = _get_hints(client, g10_state.session_id)
        mco = next(h for h in hints if h["rule_name"] == "MustContainOutie")
        state = _apply_hint(client, g10_state.session_id, mco["eliminations"])

        cg = state["candidate_grid"]
        r2c8 = cg["cells"][1][7]
        assert 7 in r2c8["auto_candidates"]

    def test_state_is_persisted_after_apply(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        """GET after POST reflects the applied elimination."""
        hints = _get_hints(client, g10_state.session_id)
        mco = next(h for h in hints if h["rule_name"] == "MustContainOutie")
        _apply_hint(client, g10_state.session_id, mco["eliminations"])

        resp = client.get(f"/api/puzzle/{g10_state.session_id}")
        assert resp.status_code == 200
        cg = resp.json()["candidate_grid"]
        r2c8 = cg["cells"][1][7]
        assert 7 in r2c8["user_removed"]

    def test_other_cells_unaffected(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        """Only the targeted cell has user_removed updated."""
        hints = _get_hints(client, g10_state.session_id)
        mco = next(h for h in hints if h["rule_name"] == "MustContainOutie")
        state = _apply_hint(client, g10_state.session_id, mco["eliminations"])

        cg = state["candidate_grid"]
        # r1c1 (0,0) should have no user_removed
        assert cg["cells"][0][0]["user_removed"] == []


# ---------------------------------------------------------------------------
# Tests: POST /hints/apply — CageConfinement after MustContainOutie
# ---------------------------------------------------------------------------


class TestApplyCageConfinement:
    def _apply_mco_and_get_confinement_hints(
        self, client: TestClient, session_id: str
    ) -> list[dict]:  # type: ignore[type-arg]
        """Apply MustContainOutie, then return CageConfinement hints."""
        hints = _get_hints(client, session_id)
        mco = next(h for h in hints if h["rule_name"] == "MustContainOutie")
        _apply_hint(client, session_id, mco["eliminations"])
        hints2 = _get_hints(client, session_id)
        return [h for h in hints2 if h["rule_name"] == "CageConfinement"]

    def test_cage_confinement_hints_appear_after_mco(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        cc_hints = self._apply_mco_and_get_confinement_hints(
            client, g10_state.session_id
        )
        assert len(cc_hints) > 0

    def test_n1_hint_eliminates_7_from_row1(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        """n=1: digit 7 in cage D is confined to row 1; eliminated from r1c1, r1c2."""
        cc_hints = self._apply_mco_and_get_confinement_hints(
            client, g10_state.session_id
        )
        n1 = next(
            (
                h
                for h in cc_hints
                if h["display_name"] == "Essential digit confined (1 cage)"
            ),
            None,
        )
        assert n1 is not None, "n=1 CageConfinement hint missing"
        assert n1["eliminations"], "n=1 hint has no eliminations"
        # Every elimination must be digit 7 in row 0 (1-based row 1)
        for elim in n1["eliminations"]:
            assert elim["digit"] == 7
            assert elim["cell"][0] == 0  # row 0 (0-based) = row 1 (1-based)

    def test_n2_hints_eliminate_6_8_9_from_rows_1_2(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        """n=2: digits 6, 8, 9 eliminated from rows 1 and 2 outside cages B and D."""
        cc_hints = self._apply_mco_and_get_confinement_hints(
            client, g10_state.session_id
        )
        n2_hints = [
            h
            for h in cc_hints
            if h["display_name"] == "Essential digit confined (2 cages)"
        ]
        n2_digits = {
            h["eliminations"][0]["digit"] for h in n2_hints if h["eliminations"]
        }
        # At least one of {6, 8, 9} should appear as an n=2 elimination
        assert n2_digits & {6, 8, 9}

    def test_applying_n1_confinement_marks_user_removed(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        """Applying the n=1 CageConfinement hint marks digit 7 as user_removed."""
        # Apply MustContainOutie first
        hints = _get_hints(client, g10_state.session_id)
        mco = next(h for h in hints if h["rule_name"] == "MustContainOutie")
        _apply_hint(client, g10_state.session_id, mco["eliminations"])

        # Get CageConfinement n=1 hint and apply it
        hints2 = _get_hints(client, g10_state.session_id)
        n1 = next(
            h
            for h in hints2
            if h["rule_name"] == "CageConfinement"
            and h["display_name"] == "Essential digit confined (1 cage)"
        )
        state = _apply_hint(client, g10_state.session_id, n1["eliminations"])

        cg = state["candidate_grid"]
        for elim in n1["eliminations"]:
            r, c = elim["cell"]
            d = elim["digit"]
            cell = cg["cells"][r][c]
            assert d in cell["user_removed"], (
                f"digit {d} not in user_removed for cell r{r + 1}c{c + 1}: {cell}"
            )

    def test_applying_n2_confinement_marks_user_removed(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        """Applying an n=2 CageConfinement hint marks target digits as user_removed."""
        # Apply MustContainOutie first
        hints = _get_hints(client, g10_state.session_id)
        mco = next(h for h in hints if h["rule_name"] == "MustContainOutie")
        _apply_hint(client, g10_state.session_id, mco["eliminations"])

        hints2 = _get_hints(client, g10_state.session_id)
        n2_hints = [
            h
            for h in hints2
            if h["rule_name"] == "CageConfinement"
            and h["display_name"] == "Essential digit confined (2 cages)"
        ]
        assert n2_hints, "No n=2 CageConfinement hints available"

        # Apply the first n=2 hint and verify all its eliminations are recorded
        state = _apply_hint(client, g10_state.session_id, n2_hints[0]["eliminations"])
        cg = state["candidate_grid"]
        for elim in n2_hints[0]["eliminations"]:
            r, c = elim["cell"]
            d = elim["digit"]
            cell = cg["cells"][r][c]
            assert d in cell["user_removed"], (
                f"digit {d} not in user_removed for cell r{r + 1}c{c + 1}: {cell}"
            )


# ---------------------------------------------------------------------------
# Tests: POST /hints/apply — edge cases
# ---------------------------------------------------------------------------


class TestApplyHintEdgeCases:
    def test_idempotent_double_apply(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        """Applying the same hint twice does not duplicate user_removed entries."""
        hints = _get_hints(client, g10_state.session_id)
        mco = next(h for h in hints if h["rule_name"] == "MustContainOutie")
        _apply_hint(client, g10_state.session_id, mco["eliminations"])
        state = _apply_hint(client, g10_state.session_id, mco["eliminations"])

        cg = state["candidate_grid"]
        r2c8 = cg["cells"][1][7]
        # user_removed should contain 7 exactly once
        assert r2c8["user_removed"].count(7) == 1

    def test_400_before_confirm(self, client: TestClient, store: SessionStore) -> None:
        spec = make_guardian10_spec()
        unconfirmed = PuzzleState(
            session_id="g10-apply-unconfirmed",
            newspaper="guardian",
            cages=_spec_to_cage_states(spec),
            spec_data=_spec_to_data(spec),
            original_image_b64="dGVzdA==",
        )
        store.save(unconfirmed)
        resp = client.post(
            f"/api/puzzle/{unconfirmed.session_id}/hints/apply",
            json={"eliminations": [{"cell": [1, 7], "digit": 7}]},
        )
        assert resp.status_code == 400

    def test_404_for_unknown_session(self, client: TestClient) -> None:
        resp = client.post(
            "/api/puzzle/nonexistent/hints/apply",
            json={"eliminations": [{"cell": [1, 7], "digit": 7}]},
        )
        assert resp.status_code == 404

    def test_empty_eliminations_is_no_op(
        self, client: TestClient, g10_state: PuzzleState
    ) -> None:
        state = _apply_hint(client, g10_state.session_id, [])
        cg = state["candidate_grid"]
        # No cell should have any user_removed entry
        for row in cg["cells"]:
            for cell in row:
                assert cell["user_removed"] == []
