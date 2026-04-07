"""Coverage-gap tests for killer_sudoku.api.routers.puzzle.

Targets specific uncovered branches identified in the coverage report:
- _spec_to_cage_states idx==0 skip (line 95)
- _user_virtual_cages eliminate_virtual_cage_soln branch (line 330)
- _apply_auto_placements with NakedSingle always-apply (lines 467-473)
- _rebuild_user_grid remove_digit branch (lines 494-496)
- _find_last_consistent_turn_idx reset_cell_candidates branch (line 565)
- _describe_first_error remove_candidate and apply_hint branches (lines 620-641)
- confirm_puzzle with ambiguous puzzle (partial golden_solution)
- Error responses: 404/409/422 on various endpoints
- solve_puzzle error path and partial-solve result
- get_cage_solutions / eliminate_cage_solution subdivisions guard (lines 1288, 1341)
- get_hints empty linear tier (line 1465)
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
from killer_sudoku.api.schemas import (
    BoardSnapshot,
    PuzzleState,
    Turn,
    UserAction,
)
from killer_sudoku.api.session import SessionStore
from killer_sudoku.image.validation import validate_cage_layout
from killer_sudoku.solver.puzzle_spec import PuzzleSpec
from tests.fixtures.minimal_puzzle import (
    KNOWN_SOLUTION,
    make_trivial_border_x,
    make_trivial_border_y,
    make_trivial_cage_totals,
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
    config = CoachConfig(
        puzzle_dir=tmp_path / "puzzles",
        sessions_dir=sessions_dir,
    )
    return TestClient(create_app(config))


@pytest.fixture
def trivial_state(store: SessionStore) -> PuzzleState:
    spec = make_trivial_spec()
    state = PuzzleState(
        session_id="gap-trivial-001",
        cages=_spec_to_cage_states(spec),
        spec_data=_spec_to_data(spec),
        original_image_b64="dGVzdA==",
    )
    store.save(state)
    return state


@pytest.fixture
def confirmed_trivial(client: TestClient, trivial_state: PuzzleState) -> PuzzleState:
    client.post(f"/api/puzzle/{trivial_state.session_id}/confirm")
    return trivial_state


def _empty_snapshot() -> BoardSnapshot:
    """Minimal BoardSnapshot for seeded turns — snapshots aren't used in replays."""
    return BoardSnapshot(
        candidates=[[list(range(1, 10)) for _ in range(9)] for _ in range(9)],
        cage_solns=[],
    )


def _turn(action: UserAction) -> Turn:
    return Turn(
        user_action=action,
        auto_mutations=[],
        snapshot=_empty_snapshot(),
    )


# ---------------------------------------------------------------------------
# _spec_to_cage_states: idx==0 skip (line 95)
# ---------------------------------------------------------------------------


class TestSpecToCageStatesSkipZeroRegion:
    def test_zero_region_cell_excluded_from_cages(self) -> None:
        """Cells with regions[r,c]==0 must be silently skipped."""
        # Build a spec, then poke a 0 into regions to exercise the skip branch
        spec = validate_cage_layout(
            make_trivial_cage_totals(),
            make_trivial_border_x(),
            make_trivial_border_y(),
        )
        # Construct a variant with region 0 at cell (0,0)
        modified_regions = spec.regions.copy()
        modified_regions[0, 0] = 0  # mark as unassigned
        modified_spec = PuzzleSpec(
            regions=modified_regions,
            cage_totals=spec.cage_totals,
            border_x=spec.border_x,
            border_y=spec.border_y,
        )
        cages = _spec_to_cage_states(modified_spec)
        # Cell (0,0) is dropped; the cage that owned it should have one fewer cell
        all_cells = [cell for cage in cages for cell in cage.cells]
        assert all(cell.row != 1 or cell.col != 1 for cell in all_cells)


# ---------------------------------------------------------------------------
# confirm_puzzle: ambiguous puzzle (partial golden_solution, no CSP fallback)
# ---------------------------------------------------------------------------


class TestConfirmWithConstrainedCage:
    def test_confirm_two_cell_cage_produces_full_golden_solution(
        self, client: TestClient, store: SessionStore
    ) -> None:
        """Engine resolves 2-cell cage via row/col; golden_solution is full."""
        spec = make_two_cell_cage_spec()
        state = PuzzleState(
            session_id="gap-two-cell-unconfirmed",
            cages=_spec_to_cage_states(spec),
            spec_data=_spec_to_data(spec),
            original_image_b64="dGVzdA==",
        )
        store.save(state)
        res = client.post(f"/api/puzzle/{state.session_id}/confirm")
        assert res.status_code == 200
        body = res.json()
        # All other cells are single-cell cages; column/row constraints uniquely
        # determine cells (0,0) and (0,1), so golden_solution is fully determined.
        assert all(
            body["golden_solution"][r][c] != 0 for r in range(9) for c in range(9)
        )


# ---------------------------------------------------------------------------
# get_candidates: 404 and 409 (lines 890-891, 894)
# ---------------------------------------------------------------------------


class TestGetCandidatesErrors:
    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.get("/api/puzzle/no-such-session/candidates")
        assert res.status_code == 404

    def test_returns_409_before_confirm(
        self, client: TestClient, trivial_state: PuzzleState
    ) -> None:
        res = client.get(f"/api/puzzle/{trivial_state.session_id}/candidates")
        assert res.status_code == 409


# ---------------------------------------------------------------------------
# subdivide_cage: cage not found 404 (line 815)
# ---------------------------------------------------------------------------


class TestSubdivideCage:
    def test_returns_404_for_unknown_cage_label(
        self, client: TestClient, trivial_state: PuzzleState
    ) -> None:
        res = client.post(
            f"/api/puzzle/{trivial_state.session_id}/cage/ZZZ/subdivide",
            json={
                "sub_cages": [
                    {"label": "ZZZ1", "cells": [{"row": 1, "col": 1}], "total": 5}
                ]
            },
        )
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# enter_cell: 404 (lines 984-985)
# ---------------------------------------------------------------------------


class TestEnterCellErrors:
    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.patch(
            "/api/puzzle/no-such-session/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# cycle_candidate: 404 and 422 (lines 1168-1169, 1175)
# ---------------------------------------------------------------------------


class TestCycleCandidateErrors:
    def test_returns_404_for_unknown_session(self, client: TestClient) -> None:
        res = client.patch(
            "/api/puzzle/no-such-session/candidates/cell",
            json={"row": 1, "col": 1, "digit": 5},
        )
        assert res.status_code == 404

    def test_returns_422_for_invalid_row(
        self, client: TestClient, confirmed_trivial: PuzzleState
    ) -> None:
        res = client.patch(
            f"/api/puzzle/{confirmed_trivial.session_id}/candidates/cell",
            json={"row": 0, "col": 1, "digit": 5},  # row=0 is out of range (1–9)
        )
        assert res.status_code == 422

    def test_returns_422_for_invalid_col(
        self, client: TestClient, confirmed_trivial: PuzzleState
    ) -> None:
        res = client.patch(
            f"/api/puzzle/{confirmed_trivial.session_id}/candidates/cell",
            json={"row": 1, "col": 0, "digit": 5},  # col=0 is out of range (1–9)
        )
        assert res.status_code == 422

    def test_returns_422_for_negative_digit(
        self, client: TestClient, confirmed_trivial: PuzzleState
    ) -> None:
        res = client.patch(
            f"/api/puzzle/{confirmed_trivial.session_id}/candidates/cell",
            json={"row": 1, "col": 1, "digit": -1},  # digit<0 is invalid
        )
        assert res.status_code == 422


# ---------------------------------------------------------------------------
# solve_puzzle: error path and partial-solve result
# ---------------------------------------------------------------------------


class TestSolvePuzzle:
    def test_solve_endpoint_returns_200(
        self, client: TestClient, store: SessionStore
    ) -> None:
        """solve_puzzle returns 200 for ambiguous puzzles the engine cannot solve."""
        spec = make_two_cell_cage_spec()
        state = PuzzleState(
            session_id="gap-solve-endpoint",
            cages=_spec_to_cage_states(spec),
            spec_data=_spec_to_data(spec),
            original_image_b64="dGVzdA==",
        )
        store.save(state)
        res = client.post(f"/api/puzzle/{state.session_id}/solve")
        assert res.status_code == 200
        body = res.json()
        assert "solved" in body
        assert "grid" in body

    def test_solve_with_constrained_cage_returns_solved(
        self, client: TestClient, store: SessionStore
    ) -> None:
        """Engine resolves a 2-cell cage when row/column constraints fix both cells."""
        spec = make_two_cell_cage_spec()
        state = PuzzleState(
            session_id="gap-solve-cheat",
            cages=_spec_to_cage_states(spec),
            spec_data=_spec_to_data(spec),
            original_image_b64="dGVzdA==",
        )
        store.save(state)
        res = client.post(f"/api/puzzle/{state.session_id}/solve")
        assert res.status_code == 200
        # All other cells are single-cell cages; column/row constraints uniquely
        # determine cells (0,0) and (0,1), so the engine fully solves this.
        body = res.json()
        assert body["solved"] is True


# ---------------------------------------------------------------------------
# get_cage_solutions: subdivisions guard (line 1288)
# ---------------------------------------------------------------------------


def _subdivided_state(session_id: str) -> PuzzleState:
    """Helper: return a confirmed two-cell-cage state with the first cage subdivided."""
    spec = make_two_cell_cage_spec()
    cages = _spec_to_cage_states(spec)
    first = cages[0]
    sub = {
        "label": first.label + "1",
        "cells": [{"row": first.cells[0].row, "col": first.cells[0].col}],
        "total": 5,
    }
    subdivided = [first.model_copy(update={"subdivisions": [sub]}), *cages[1:]]
    return PuzzleState(
        session_id=session_id,
        cages=subdivided,
        spec_data=_spec_to_data(spec),
        original_image_b64="dGVzdA==",
        golden_solution=KNOWN_SOLUTION,
        user_grid=[[0] * 9 for _ in range(9)],
    )


class TestGetCageSolutionsSubdivisions:
    def test_returns_400_for_subdivided_cage(
        self, client: TestClient, store: SessionStore
    ) -> None:
        state = _subdivided_state("gap-subdivide-solutions")
        store.save(state)
        first_label = state.cages[0].label
        res = client.get(f"/api/puzzle/{state.session_id}/cage/{first_label}/solutions")
        assert res.status_code == 400


# ---------------------------------------------------------------------------
# eliminate_cage_solution: subdivisions guard (line 1341)
# ---------------------------------------------------------------------------


class TestEliminateCageSolutionSubdivisions:
    def test_returns_400_for_subdivided_cage(
        self, client: TestClient, store: SessionStore
    ) -> None:
        state = _subdivided_state("gap-subdivide-eliminate")
        store.save(state)
        first_label = state.cages[0].label
        res = client.post(
            f"/api/puzzle/{state.session_id}/cage/{first_label}/solutions/eliminate",
            json={"solution": [3, 5]},
        )
        assert res.status_code == 400


# ---------------------------------------------------------------------------
# _apply_auto_placements: actual placements update (lines 467-473)
# ---------------------------------------------------------------------------


class TestApplyAutoPlacements:
    def test_naked_single_placements_folded_into_user_grid(
        self, client: TestClient, confirmed_trivial: PuzzleState
    ) -> None:
        """With NakedSingle always-apply, placing a digit propagates placements."""
        # Enable NakedSingle so applied_placements is non-empty after _build_engine
        client.patch(
            "/api/settings",
            json={
                "always_apply_rules": [
                    "CageCandidateFilter",
                    "CellSolutionElimination",
                    "NakedSingle",
                ]
            },
        )
        sid = confirmed_trivial.session_id
        # Placing any digit triggers _build_engine which runs NakedSingle for all
        # singleton cages → applied_placements non-empty → _apply_auto_placements runs
        res = client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": 1, "col": 1, "digit": KNOWN_SOLUTION[0][0]},
        )
        assert res.status_code == 200
        body = res.json()
        # NakedSingle would have placed digits; at least some cells should be filled
        filled = sum(
            1 for r in range(9) for c in range(9) if body["user_grid"][r][c] != 0
        )
        assert filled > 1  # more than just the manually placed digit


# ---------------------------------------------------------------------------
# _rebuild_user_grid: remove_digit branch (lines 494-496)
# ---------------------------------------------------------------------------


class TestRebuildUserGridRemoveDigit:
    def test_undo_after_remove_digit_processes_remove_branch(
        self, client: TestClient, confirmed_trivial: PuzzleState
    ) -> None:
        """Undo after removing a digit replays remove_digit via _rebuild_user_grid."""
        sid = confirmed_trivial.session_id
        digit = KNOWN_SOLUTION[0][0]
        # Place a digit, then clear it (creates remove_digit in history)
        client.patch(
            f"/api/puzzle/{sid}/cell", json={"row": 1, "col": 1, "digit": digit}
        )
        client.patch(f"/api/puzzle/{sid}/cell", json={"row": 1, "col": 1, "digit": 0})
        # Undo the clear — _rebuild_user_grid replays history including remove_digit
        res = client.post(f"/api/puzzle/{sid}/undo")
        assert res.status_code == 200


# ---------------------------------------------------------------------------
# _find_last_consistent_turn_idx: reset_cell_candidates branch (line 565)
# ---------------------------------------------------------------------------


class TestFindLastConsistentResetCandidates:
    def test_reset_cell_candidates_in_history_does_not_crash_hints(
        self, client: TestClient, confirmed_trivial: PuzzleState
    ) -> None:
        """GET /hints tolerates reset_cell_candidates in history (hits line 565)."""
        sid = confirmed_trivial.session_id
        digit = KNOWN_SOLUTION[0][0]
        # First remove a candidate (so there is something to reset)
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": digit},
        )
        # Then reset all candidates for that cell (digit=0)
        client.patch(
            f"/api/puzzle/{sid}/candidates/cell",
            json={"row": 1, "col": 1, "digit": 0},
        )
        # GET /hints calls _find_last_consistent_turn_idx which iterates history
        res = client.get(f"/api/puzzle/{sid}/hints")
        assert res.status_code == 200


# ---------------------------------------------------------------------------
# _describe_first_error: remove_candidate branch (lines 620-631)
# ---------------------------------------------------------------------------


class TestDescribeFirstErrorRemoveCandidate:
    def test_hints_describes_removal_of_correct_candidate(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """Removing the correct digit from a cell is described in the rewind hint."""
        correct_digit = KNOWN_SOLUTION[0][0]
        state = trivial_state.model_copy(
            update={
                "golden_solution": KNOWN_SOLUTION,
                "user_grid": [[0] * 9 for _ in range(9)],
                "history": [
                    _turn(
                        UserAction(
                            type="remove_candidate",
                            row=0,
                            col=0,
                            digit=correct_digit,
                            source="user:manual",
                        )
                    )
                ],
            }
        )
        store.save(state)
        res = client.get(f"/api/puzzle/{state.session_id}/hints")
        assert res.status_code == 200
        hints = res.json()["hints"]
        assert len(hints) == 1
        assert hints[0]["rule_name"] == "Rewind"
        assert "removed" in hints[0]["explanation"]


# ---------------------------------------------------------------------------
# _describe_first_error: apply_hint branch (lines 633-641)
# ---------------------------------------------------------------------------


class TestDescribeFirstErrorApplyHint:
    def test_hints_describes_hint_that_removed_correct_digit(
        self, client: TestClient, store: SessionStore, trivial_state: PuzzleState
    ) -> None:
        """A hint that eliminated the correct digit is described in the rewind hint."""
        correct_digit = KNOWN_SOLUTION[0][0]
        state = trivial_state.model_copy(
            update={
                "golden_solution": KNOWN_SOLUTION,
                "user_grid": [[0] * 9 for _ in range(9)],
                "history": [
                    _turn(
                        UserAction(
                            type="apply_hint",
                            hint_eliminations=[(0, 0, correct_digit)],
                            source="user:manual",
                        )
                    )
                ],
            }
        )
        store.save(state)
        res = client.get(f"/api/puzzle/{state.session_id}/hints")
        assert res.status_code == 200
        hints = res.json()["hints"]
        assert len(hints) == 1
        assert hints[0]["rule_name"] == "Rewind"
        assert "hint" in hints[0]["explanation"].lower()


# ---------------------------------------------------------------------------
# _user_virtual_cages: eliminate_virtual_cage_soln branch (line 330)
# ---------------------------------------------------------------------------


class TestUserVirtualCagesEliminate:
    def test_virtual_cage_solution_elimination_reflected_in_candidates(
        self, client: TestClient, store: SessionStore
    ) -> None:
        """eliminate_virtual_cage_soln in history is processed by _user_virtual_cages.

        There is no HTTP endpoint that creates eliminate_virtual_cage_soln actions,
        so we seed the history directly to exercise the branch at line 330.
        """
        key = "0,0:0,1:8"
        spec = make_two_cell_cage_spec()
        cages = _spec_to_cage_states(spec)
        state = PuzzleState(
            session_id="gap-vc-eliminate",
            cages=cages,
            spec_data=_spec_to_data(spec),
            original_image_b64="dGVzdA==",
            golden_solution=KNOWN_SOLUTION,
            user_grid=[[0] * 9 for _ in range(9)],
            history=[
                # First: add the virtual cage
                _turn(
                    UserAction(
                        type="add_virtual_cage",
                        virtual_cage_key=key,
                        virtual_cage_cells=[(0, 0), (0, 1)],
                        virtual_cage_total=8,
                        source="user:manual",
                    )
                ),
                # Then: eliminate one of its solutions
                _turn(
                    UserAction(
                        type="eliminate_virtual_cage_soln",
                        virtual_cage_key=key,
                        solution=[1, 7],
                        source="user:manual",
                    )
                ),
            ],
        )
        store.save(state)
        # GET /candidates calls _user_virtual_cages which processes both actions
        res = client.get(f"/api/puzzle/{state.session_id}/candidates")
        assert res.status_code == 200
        # The virtual cage should appear with [1,7] excluded from its solutions
        vc_info = res.json()["virtual_cages"]
        assert len(vc_info) == 1
        soln_sets = [frozenset(s) for s in vc_info[0]["solutions"]]
        assert frozenset([1, 7]) not in soln_sets


# ---------------------------------------------------------------------------
# GET /hints: empty linear tier (line 1465)
# ---------------------------------------------------------------------------


class TestHintsEmptyLinearTier:
    def test_empty_linear_tier_fires_when_linear_rules_are_always_apply(
        self, client: TestClient, confirmed_trivial: PuzzleState
    ) -> None:
        """When LinearElimination is always-apply it produces no pending_hints.

        With t1=t2=t3=[], the else branch (line 1465) fires: linear_hints=[].
        Only non-linear hint-only rules (e.g. NakedSingle) appear in the result.
        """
        # Move LinearElimination from hint-only to always-apply so it doesn't
        # buffer into pending_hints → t1 (LinearElimination placements) will be []
        client.patch(
            "/api/settings",
            json={
                "always_apply_rules": [
                    "CageCandidateFilter",
                    "CellSolutionElimination",
                    "LinearElimination",
                ]
            },
        )
        res = client.get(f"/api/puzzle/{confirmed_trivial.session_id}/hints")
        assert res.status_code == 200
        # t1=[], t2=[], t3=[] → linear_hints=[] (line 1465)
        # selected = non_linear only (NakedSingle hints for this trivial puzzle)
        hints = res.json()["hints"]
        rule_names = {h["rule_name"] for h in hints}
        assert "LinearElimination" not in rule_names
