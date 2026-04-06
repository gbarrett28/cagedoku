"""Tests for inconsistency detection and the /rewind endpoint.

Covers:
  - _find_last_consistent_turn_idx unit tests (pure logic, no I/O)
  - GET /hints returns Rewind hint when board conflicts with golden_solution
  - POST /rewind endpoint: 404/409/422 error cases and successful rewind
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig
from killer_sudoku.api.routers.puzzle import (
    _find_last_consistent_turn_idx,
    _spec_to_cage_states,
    _spec_to_data,
)
from killer_sudoku.api.schemas import (
    AutoMutation,
    PuzzleState,
    Turn,
    UserAction,
)
from killer_sudoku.api.session import SessionStore
from tests.api.test_hints import GUARDIAN10_SOLUTION
from tests.fixtures.guardian10_puzzle import make_guardian10_spec

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
        puzzle_dir=tmp_path / "puzzles",
        sessions_dir=sessions_dir,
    )
    return TestClient(create_app(config))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _place_turn(row: int, col: int, digit: int) -> Turn:
    """Build a place_digit Turn (0-based row/col)."""
    return Turn(
        user_action=UserAction(
            type="place_digit",
            row=row,
            col=col,
            digit=digit,
            source="user:manual",
        ),
        auto_mutations=[],
    )


def _remove_cand_turn(row: int, col: int, digit: int) -> Turn:
    """Build a remove_candidate Turn (0-based row/col)."""
    return Turn(
        user_action=UserAction(
            type="remove_candidate",
            row=row,
            col=col,
            digit=digit,
            source="user:manual",
        ),
        auto_mutations=[],
    )


def _restore_cand_turn(row: int, col: int, digit: int) -> Turn:
    """Build a restore_candidate Turn (0-based row/col)."""
    return Turn(
        user_action=UserAction(
            type="restore_candidate",
            row=row,
            col=col,
            digit=digit,
            source="user:manual",
        ),
        auto_mutations=[],
    )


def _apply_hint_turn(eliminations: list[tuple[int, int, int]]) -> Turn:
    """Build an apply_hint Turn (0-based coordinates)."""
    return Turn(
        user_action=UserAction(
            type="apply_hint",
            hint_eliminations=eliminations,
            source="user:hint",
        ),
        auto_mutations=[
            AutoMutation(
                rule_name="TestRule",
                type="candidate_removed",
                row=eliminations[0][0],
                col=eliminations[0][1],
                digit=eliminations[0][2],
            )
        ],
    )


def _minimal_state(
    history: list[Turn],
    golden: list[list[int]] | None = None,
) -> PuzzleState:
    """Minimal confirmed PuzzleState with a given history and golden_solution."""
    spec = make_guardian10_spec()
    return PuzzleState(
        session_id="test",
        newspaper="guardian",
        cages=_spec_to_cage_states(spec),
        spec_data=_spec_to_data(spec),
        original_image_b64="dGVzdA==",
        golden_solution=golden,
        user_grid=[[0] * 9 for _ in range(9)],
        history=history,
    )


def _make_g10_state_with_golden(store: SessionStore) -> tuple[str, PuzzleState]:
    """Seed a confirmed guardian-10 state with golden_solution; return (sid, state)."""
    spec = make_guardian10_spec()
    sid = str(uuid.uuid4())
    state = PuzzleState(
        session_id=sid,
        newspaper="guardian",
        cages=_spec_to_cage_states(spec),
        spec_data=_spec_to_data(spec),
        original_image_b64="dGVzdA==",
        golden_solution=GUARDIAN10_SOLUTION,
        user_grid=[[0] * 9 for _ in range(9)],
    )
    store.save(state)
    return sid, state


# ---------------------------------------------------------------------------
# Unit tests: _find_last_consistent_turn_idx
# ---------------------------------------------------------------------------


class TestFindLastConsistentTurnIdx:
    def test_no_history_returns_none(self) -> None:
        state = _minimal_state([], golden=GUARDIAN10_SOLUTION)
        assert _find_last_consistent_turn_idx(state) is None

    def test_no_golden_solution_returns_none(self) -> None:
        state = _minimal_state([_place_turn(0, 0, 99)], golden=None)
        assert _find_last_consistent_turn_idx(state) is None

    def test_correct_digit_returns_none(self) -> None:
        # GUARDIAN10_SOLUTION[0][0] == 3
        state = _minimal_state([_place_turn(0, 0, 3)], golden=GUARDIAN10_SOLUTION)
        assert _find_last_consistent_turn_idx(state) is None

    def test_wrong_digit_returns_zero(self) -> None:
        # Place wrong digit as first turn → rewind to index 0 (empty history)
        state = _minimal_state(
            [_place_turn(0, 0, 9)],  # correct is 3
            golden=GUARDIAN10_SOLUTION,
        )
        assert _find_last_consistent_turn_idx(state) == 0

    def test_wrong_digit_after_correct_turns(self) -> None:
        # Two correct turns, then a wrong digit → rewind to index 2
        state = _minimal_state(
            [
                _place_turn(0, 0, 3),  # correct
                _place_turn(0, 1, 5),  # correct
                _place_turn(0, 2, 9),  # wrong (correct is 8)
            ],
            golden=GUARDIAN10_SOLUTION,
        )
        assert _find_last_consistent_turn_idx(state) == 2

    def test_wrong_digit_then_corrected_returns_none(self) -> None:
        # Wrong digit placed then removed → state recovers → no rewind needed
        state = _minimal_state(
            [
                _place_turn(0, 0, 9),  # wrong
                Turn(
                    user_action=UserAction(
                        type="remove_digit",
                        row=0,
                        col=0,
                        source="user:manual",
                    ),
                    auto_mutations=[],
                ),
            ],
            golden=GUARDIAN10_SOLUTION,
        )
        assert _find_last_consistent_turn_idx(state) is None

    def test_remove_golden_candidate_detected(self) -> None:
        # Remove the golden digit from its cell → inconsistent
        # GUARDIAN10_SOLUTION[1][0] == 7
        state = _minimal_state(
            [_remove_cand_turn(1, 0, 7)],
            golden=GUARDIAN10_SOLUTION,
        )
        assert _find_last_consistent_turn_idx(state) == 0

    def test_remove_non_golden_candidate_returns_none(self) -> None:
        # Remove a digit that is NOT the golden solution → still consistent
        # GUARDIAN10_SOLUTION[1][0] == 7, so removing 5 is fine
        state = _minimal_state(
            [_remove_cand_turn(1, 0, 5)],
            golden=GUARDIAN10_SOLUTION,
        )
        assert _find_last_consistent_turn_idx(state) is None

    def test_restore_candidate_recovers_consistency(self) -> None:
        # Remove golden digit then restore it → consistent again
        state = _minimal_state(
            [
                _remove_cand_turn(1, 0, 7),  # inconsistent
                _restore_cand_turn(1, 0, 7),  # restored
            ],
            golden=GUARDIAN10_SOLUTION,
        )
        assert _find_last_consistent_turn_idx(state) is None

    def test_apply_hint_with_golden_elimination_detected(self) -> None:
        # Hint eliminates the golden digit from a cell → inconsistent
        # GUARDIAN10_SOLUTION[2][0] == 2
        state = _minimal_state(
            [_apply_hint_turn([(2, 0, 2)])],
            golden=GUARDIAN10_SOLUTION,
        )
        assert _find_last_consistent_turn_idx(state) == 0

    def test_apply_hint_safe_elimination_returns_none(self) -> None:
        # Hint eliminates a non-golden digit → consistent
        # GUARDIAN10_SOLUTION[2][0] == 2, so eliminating 9 is fine
        state = _minimal_state(
            [_apply_hint_turn([(2, 0, 9)])],
            golden=GUARDIAN10_SOLUTION,
        )
        assert _find_last_consistent_turn_idx(state) is None

    def test_golden_zero_cells_ignored(self) -> None:
        # Build a golden solution with a 0 in position (0,0) — any digit is OK
        partial_golden = [row[:] for row in GUARDIAN10_SOLUTION]
        partial_golden[0][0] = 0
        state = _minimal_state(
            [_place_turn(0, 0, 9)],  # 9 is "wrong" but (0,0) is unknown
            golden=partial_golden,
        )
        assert _find_last_consistent_turn_idx(state) is None


# ---------------------------------------------------------------------------
# API tests: GET /hints returns Rewind hint on inconsistency
# ---------------------------------------------------------------------------


class TestHintsReturnsRewindOnInconsistency:
    def test_no_rewind_hint_when_consistent(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state_with_golden(store)
        hints = client.get(f"/api/puzzle/{sid}/hints").json()["hints"]
        assert all(h["rule_name"] != "Rewind" for h in hints)

    def test_rewind_hint_returned_on_wrong_digit(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, state = _make_g10_state_with_golden(store)
        # Place wrong digit in r1c1 (0-based: row=0, col=0, golden=3)
        client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": 9},  # 1-based API; golden is 3
        )
        hints = client.get(f"/api/puzzle/{sid}/hints").json()["hints"]
        assert len(hints) == 1
        assert hints[0]["rule_name"] == "Rewind"

    def test_rewind_hint_suppresses_normal_hints(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state_with_golden(store)
        client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": 9},
        )
        hints = client.get(f"/api/puzzle/{sid}/hints").json()["hints"]
        # Only the Rewind hint — no solver rules
        assert len(hints) == 1

    def test_rewind_hint_has_correct_turn_idx(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state_with_golden(store)
        # Place two correct digits, then one wrong one
        client.patch(f"/api/puzzle/{sid}/cell", json={"row": 1, "col": 1, "digit": 3})
        client.patch(f"/api/puzzle/{sid}/cell", json={"row": 1, "col": 2, "digit": 5})
        # wrong digit at r1c3 (correct is 8)
        client.patch(f"/api/puzzle/{sid}/cell", json={"row": 1, "col": 3, "digit": 1})
        hints = client.get(f"/api/puzzle/{sid}/hints").json()["hints"]
        assert hints[0]["rule_name"] == "Rewind"
        # Should rewind to index 2 (keep first two correct turns)
        assert hints[0]["rewind_to_turn_idx"] == 2

    def test_rewind_hint_explanation_mentions_digit(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state_with_golden(store)
        client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": 9},
        )
        hints = client.get(f"/api/puzzle/{sid}/hints").json()["hints"]
        assert "9" in hints[0]["explanation"]


# ---------------------------------------------------------------------------
# API tests: POST /rewind endpoint
# ---------------------------------------------------------------------------


class TestRewindEndpoint:
    def test_404_unknown_session(self, client: TestClient) -> None:
        resp = client.post("/api/puzzle/does-not-exist/rewind", json={"turn_idx": 0})
        assert resp.status_code == 404

    def test_409_unconfirmed_session(
        self, client: TestClient, store: SessionStore
    ) -> None:
        spec = make_guardian10_spec()
        sid = str(uuid.uuid4())
        state = PuzzleState(
            session_id=sid,
            newspaper="guardian",
            cages=_spec_to_cage_states(spec),
            spec_data=_spec_to_data(spec),
            original_image_b64="dGVzdA==",
            user_grid=None,
        )
        store.save(state)
        resp = client.post(f"/api/puzzle/{sid}/rewind", json={"turn_idx": 0})
        assert resp.status_code == 409

    def test_422_turn_idx_out_of_range(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state_with_golden(store)
        resp = client.post(f"/api/puzzle/{sid}/rewind", json={"turn_idx": 999})
        assert resp.status_code == 422

    def test_422_negative_turn_idx(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state_with_golden(store)
        resp = client.post(f"/api/puzzle/{sid}/rewind", json={"turn_idx": -1})
        assert resp.status_code == 422

    def test_rewind_to_zero_clears_grid(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state_with_golden(store)
        client.patch(f"/api/puzzle/{sid}/cell", json={"row": 1, "col": 1, "digit": 3})
        resp = client.post(f"/api/puzzle/{sid}/rewind", json={"turn_idx": 0})
        assert resp.status_code == 200
        state = resp.json()
        # All cells cleared
        assert all(state["user_grid"][r][c] == 0 for r in range(9) for c in range(9))
        assert state["history"] == []

    def test_rewind_restores_prior_digits(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state_with_golden(store)
        client.patch(f"/api/puzzle/{sid}/cell", json={"row": 1, "col": 1, "digit": 3})
        client.patch(f"/api/puzzle/{sid}/cell", json={"row": 2, "col": 2, "digit": 4})
        client.patch(f"/api/puzzle/{sid}/cell", json={"row": 1, "col": 3, "digit": 9})
        # Rewind to turn 2 — keep first two turns only
        resp = client.post(f"/api/puzzle/{sid}/rewind", json={"turn_idx": 2})
        assert resp.status_code == 200
        state = resp.json()
        assert state["user_grid"][0][0] == 3  # 0-based: row=0, col=0
        assert state["user_grid"][1][1] == 4  # row=1, col=1
        assert state["user_grid"][0][2] == 0  # rewound — was 9, now cleared
        assert len(state["history"]) == 2

    def test_rewind_followed_by_consistent_hints(
        self, client: TestClient, store: SessionStore
    ) -> None:
        """After a successful rewind the hints endpoint returns no Rewind hint."""
        sid, _ = _make_g10_state_with_golden(store)
        client.patch(f"/api/puzzle/{sid}/cell", json={"row": 1, "col": 1, "digit": 9})
        # Confirm inconsistency
        hints_before = client.get(f"/api/puzzle/{sid}/hints").json()["hints"]
        assert hints_before[0]["rule_name"] == "Rewind"
        turn_idx = hints_before[0]["rewind_to_turn_idx"]
        # Apply rewind
        client.post(f"/api/puzzle/{sid}/rewind", json={"turn_idx": turn_idx})
        # Now hints should be normal solver hints (or empty), not Rewind
        hints_after = client.get(f"/api/puzzle/{sid}/hints").json()["hints"]
        assert all(h["rule_name"] != "Rewind" for h in hints_after)
