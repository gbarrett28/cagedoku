"""Auto-solve test: simulate a human player working through Guardian puzzle 10.

The test drives the puzzle to completion using the coaching API:

  1. Fetch the top hint from GET /{id}/hints.
  2. Validate it against the golden solution (placement correct, no correct
     digit eliminated, virtual cage sum consistent).
  3. Apply it via the appropriate endpoint.
  4. Repeat until solved.

When no coaching hints are available and the puzzle is unsolved, the test
falls back to "archive" rules (the incomplete rule set used by the batch
solver but not yet surfaced in the coaching UI).  Archive eliminations are
applied as a bulk hint-apply step so the session state remains consistent.

The test reports which archive rules were needed and how many virtual cage
hints were suggested versus how many actually narrowed any candidate.

Implementation note on candidates snapshot
------------------------------------------
get_candidates adds user_removed digits back into the candidates list for
strikethrough rendering.  A plain snapshot of candidates is therefore
unchanged when a hint is applied (the digit moves from board.candidates to
user_removed but re-appears via the union).  Effective candidates are
computed as  candidates − user_removed  which strictly shrinks as the user
acknowledges eliminations, making it a correct progress measure.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig
from killer_sudoku.api.routers.puzzle import (
    _data_to_spec,
    _spec_to_cage_states,
    _spec_to_data,
    _user_eliminations,
    _user_removed,
    _user_virtual_cages,
)
from killer_sudoku.api.schemas import PuzzleState
from killer_sudoku.api.session import SessionStore
from killer_sudoku.solver.engine import (
    BoardState,
    SolverEngine,
    all_rules,
    default_rules,
)
from killer_sudoku.solver.engine.board_state import NoSolnError
from killer_sudoku.solver.engine.types import Elimination
from tests.fixtures.guardian10_puzzle import make_guardian10_spec

# ---------------------------------------------------------------------------
# Golden solution
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

# Names of rules active in coaching mode; used to identify archive rules.
_COACHING_RULE_NAMES: frozenset[str] = frozenset(r.name for r in default_rules())

MAX_STEPS = 1000  # guardian 10 should complete in far fewer


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
# Session setup
# ---------------------------------------------------------------------------


def _seed_g10_session(store: SessionStore) -> str:
    """Seed a confirmed guardian-10 session; return session_id."""
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
    return sid


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------


def _get_hints(client: TestClient, sid: str) -> list[dict[str, Any]]:
    resp = client.get(f"/api/puzzle/{sid}/hints")
    assert resp.status_code == 200, resp.text
    return resp.json()["hints"]  # type: ignore[no-any-return]


def _get_candidates(client: TestClient, sid: str) -> dict[str, Any]:
    resp = client.get(f"/api/puzzle/{sid}/candidates")
    assert resp.status_code == 200, resp.text
    return resp.json()  # type: ignore[no-any-return]


def _effective_snapshot(cands: dict[str, Any]) -> list[list[frozenset[int]]]:
    """Effective candidates per cell: displayed candidates minus user_removed.

    get_candidates adds user_removed back into the candidates list for
    strikethrough display.  Subtracting user_removed gives the digits the
    engine still considers genuinely possible — this set shrinks monotonically
    as hints are applied, making it the correct progress measure.
    """
    return [
        [
            frozenset(cands["cells"][r][c]["candidates"])
            - frozenset(cands["cells"][r][c]["user_removed"])
            for c in range(9)
        ]
        for r in range(9)
    ]


def _is_solved(cands: dict[str, Any]) -> bool:
    """True when every cell has exactly one effective candidate."""
    return all(
        len(
            frozenset(cands["cells"][r][c]["candidates"])
            - frozenset(cands["cells"][r][c]["user_removed"])
        )
        == 1
        for r in range(9)
        for c in range(9)
    )


def _session_progress_key(state: PuzzleState) -> tuple[int, int, int]:
    """A key that changes whenever any user action makes progress.

    Tracks (placed_cells, user_removed_count, virtual_cage_count).
    Unchanged across steps = genuine stall.
    """
    placed = sum(
        1
        for r in range(9)
        for c in range(9)
        if state.user_grid is not None and state.user_grid[r][c] != 0
    )
    removed = len(list(_user_removed(state)))
    vcs = len(list(_user_virtual_cages(state)))
    return placed, removed, vcs


# ---------------------------------------------------------------------------
# Hint validation
# ---------------------------------------------------------------------------


def _validate_hint(
    hint: dict[str, Any], golden: list[list[int]], step: int = -1
) -> None:
    """Assert hint is consistent with the golden solution.

    Raises AssertionError with a descriptive message if:
    - A placement hint names the wrong digit.
    - An elimination hint removes a digit that is the golden answer.
    - A virtual cage suggestion has an incorrect sum.
    """
    if hint.get("rewind_to_turn_idx") is not None:
        return  # rewind hints are structural

    if hint.get("placement") is not None:
        r, c, d = hint["placement"]
        assert golden[r][c] == d, (
            f"WRONG placement: r{r + 1}c{c + 1} = {d} (golden = {golden[r][c]})"
        )

    for elim in hint.get("eliminations", []):
        r, c = elim["cell"]
        d = elim["digit"]
        assert golden[r][c] != d, (
            f"WRONG elimination at step {step}: removes correct digit {d} from "
            f"r{r + 1}c{c + 1} (golden = {golden[r][c]})\n"
            f"  hint: {hint['rule_name']} — {hint['display_name']}\n"
            f"  all elims: {hint['eliminations']}"
        )

    vc = hint.get("virtual_cage_suggestion")
    if vc is not None:
        cells = vc["cells"]
        total = vc["total"]
        actual = sum(golden[r][c] for r, c in cells)
        assert actual == total, (
            f"WRONG virtual cage: cells {cells} sum to {actual} in golden "
            f"but suggestion says {total}"
        )


# ---------------------------------------------------------------------------
# Hint application
# ---------------------------------------------------------------------------


def _apply_hint_item(client: TestClient, sid: str, hint: dict[str, Any]) -> None:
    """Apply one hint item via the correct API endpoint."""
    if hint.get("placement") is not None:
        r, c, d = hint["placement"]
        resp = client.patch(
            f"/api/puzzle/{sid}/cell",
            json={"row": r + 1, "col": c + 1, "digit": d},
        )
        assert resp.status_code == 200, f"PATCH /cell failed: {resp.text}"
        return

    if hint.get("virtual_cage_suggestion") is not None:
        vc = hint["virtual_cage_suggestion"]
        resp = client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": vc["cells"], "total": vc["total"]},
        )
        assert resp.status_code == 200, f"POST /virtual-cages failed: {resp.text}"
        return

    resp = client.post(
        f"/api/puzzle/{sid}/hints/apply",
        json={"eliminations": hint["eliminations"]},
    )
    assert resp.status_code == 200, f"POST /hints/apply failed: {resp.text}"


# ---------------------------------------------------------------------------
# Archive rule fallback
# ---------------------------------------------------------------------------


def _build_engine_for_state(
    state: PuzzleState,
    *,
    use_all_rules: bool,
) -> tuple[BoardState, SolverEngine]:
    """Reconstruct a board + engine from session state and run to convergence."""
    spec = _data_to_spec(state.spec_data)
    include_vc = use_all_rules
    board = BoardState(spec, include_virtual_cages=include_vc)

    for vc in _user_virtual_cages(state):
        board.add_virtual_cage(
            frozenset((int(c[0]), int(c[1])) for c in vc.cells),
            vc.total,
            [frozenset(s) for s in vc.eliminated_solns],
        )

    rules = list(all_rules() if use_all_rules else default_rules())
    engine = SolverEngine(
        board,
        rules=rules,
        linear_system_active=use_all_rules,
        hint_rules=frozenset(),
    )

    if state.user_grid is not None:
        engine.apply_eliminations(_user_eliminations(board, state.user_grid))

    for r, c, d in _user_removed(state):
        if d in board.candidates[r][c] and len(board.candidates[r][c]) > 1:
            engine.apply_eliminations([Elimination(cell=(r, c), digit=d)])

    for cage_idx, cage in enumerate(state.cages):
        for soln in cage.user_eliminated_solns:
            fs = frozenset(soln)
            if fs in board.cage_solns[cage_idx]:
                board.cage_solns[cage_idx].remove(fs)

    engine.solve()
    return board, engine


def _try_archive_rules(
    state: PuzzleState,
) -> tuple[list[str], list[Elimination]]:
    """Find eliminations archive rules can make beyond the coaching board.

    Runs the coaching engine (default_rules) and the full engine (all_rules)
    to convergence from the same session state.  Returns the archive rule
    names that fired and the eliminations present in the coaching board that
    the full board removes.

    Returns ([], []) if no archive rule makes additional progress.
    """
    coaching_board, _ = _build_engine_for_state(state, use_all_rules=False)

    try:
        full_board, full_engine = _build_engine_for_state(state, use_all_rules=True)
    except NoSolnError:
        return [], []

    # Digits the full board removed that the coaching board still has.
    new_elims: list[Elimination] = [
        Elimination(cell=(r, c), digit=d)
        for r in range(9)
        for c in range(9)
        for d in coaching_board.candidates[r][c] - full_board.candidates[r][c]
    ]

    if not new_elims:
        return [], []

    archive_names = sorted(
        name
        for name, stats in full_engine.stats.items()
        if name not in _COACHING_RULE_NAMES and stats.eliminations > 0
    )
    return archive_names, new_elims


# ---------------------------------------------------------------------------
# Auto-solve test
# ---------------------------------------------------------------------------


class TestAutoSolveGuardian10:
    """Play Guardian puzzle 10 to completion using coaching hints + archive fallback.

    Test documents:
    - Every hint applied (rule name, description, effect).
    - Archive fallbacks: which rules and how many eliminations.
    - Virtual cage hints: how many suggested vs. how many narrowed candidates.
    """

    def test_solve(
        self,
        client: TestClient,
        store: SessionStore,
    ) -> None:
        sid = _seed_g10_session(store)
        golden = GUARDIAN10_SOLUTION

        step_log: list[str] = []
        archive_log: list[tuple[int, list[str], int]] = []
        # key -> True if the vc narrowed effective candidates, False otherwise
        vc_log: dict[str, bool] = {}

        prev_progress_key: tuple[int, int, int] | None = None

        for step in range(MAX_STEPS):
            cands = _get_candidates(client, sid)

            if _is_solved(cands):
                self._report(step, step_log, archive_log, vc_log)
                return  # PASS

            state = store.load(sid)
            current_key = _session_progress_key(state)

            # Stall: two consecutive iterations with no change in placed/removed/vcs.
            if current_key == prev_progress_key:
                pytest.fail(
                    f"Stalled at step {step}: no progress since last step "
                    f"(placed={current_key[0]}, removed={current_key[1]}, "
                    f"vcs={current_key[2]}).\n"
                    + self._summary(step_log, archive_log, vc_log)
                )
            prev_progress_key = current_key

            hints = _get_hints(client, sid)

            if not hints:
                # No coaching hints — try archive rules.
                archive_names, archive_elims = _try_archive_rules(state)

                if not archive_elims:
                    pytest.fail(
                        f"Stuck at step {step}: no coaching hints and no archive "
                        "rules made progress.\n"
                        + self._summary(step_log, archive_log, vc_log)
                    )

                for e in archive_elims:
                    r, c = e.cell
                    assert golden[r][c] != e.digit, (
                        f"WRONG archive elimination at step {step}: "
                        f"removes correct digit {e.digit} from r{r + 1}c{c + 1} "
                        f"(golden = {golden[r][c]})\n"
                        f"  archive rules: {archive_names}\n"
                        + self._summary(step_log, archive_log, vc_log)
                    )

                archive_log.append((step, archive_names, len(archive_elims)))
                step_log.append(
                    f"Step {step:3d} [ARCHIVE {'+'.join(archive_names) or '?'}]:"
                    f" {len(archive_elims)} elim"
                    f"{'s' if len(archive_elims) != 1 else ''}"
                )
                resp = client.post(
                    f"/api/puzzle/{sid}/hints/apply",
                    json={
                        "eliminations": [
                            {"cell": list(e.cell), "digit": e.digit}
                            for e in archive_elims
                        ]
                    },
                )
                assert resp.status_code == 200, (
                    f"POST /hints/apply (archive) failed: {resp.text}"
                )
                continue

            hint = hints[0]
            try:
                _validate_hint(hint, golden, step)
            except AssertionError as exc:
                pytest.fail(
                    str(exc) + "\n" + self._summary(step_log, archive_log, vc_log)
                )

            if hint.get("virtual_cage_suggestion") is not None:
                # T3 hint: apply and check whether effective candidates narrowed.
                cells = hint["virtual_cage_suggestion"]["cells"]
                total = hint["virtual_cage_suggestion"]["total"]
                vc_key = f"{sorted(cells)}={total}"
                snap_before = _effective_snapshot(cands)

                _apply_hint_item(client, sid, hint)

                cands_after = _get_candidates(client, sid)
                snap_after = _effective_snapshot(cands_after)
                helped = snap_after != snap_before

                # Validate that no golden candidate was incorrectly eliminated.
                for vr in range(9):
                    for vc_ in range(9):
                        for removed_d in snap_before[vr][vc_] - snap_after[vr][vc_]:
                            assert golden[vr][vc_] != removed_d, (
                                f"T3 VC at step {step} caused wrong elimination of "
                                f"{removed_d} from r{vr + 1}c{vc_ + 1} "
                                f"(golden={golden[vr][vc_]})\n"
                                f"  VC cells={sorted(cells)}, total={total}\n"
                                + self._summary(step_log, archive_log, vc_log)
                            )
                vc_log[vc_key] = helped

                step_log.append(
                    f"Step {step:3d} [T3 VirtualCage]: {hint['display_name']}"
                    f" cells={sorted(cells)}"
                    f" — {'HELPED' if helped else 'no effect'}"
                )

            elif hint.get("placement") is not None:
                r, c, d = hint["placement"]
                _apply_hint_item(client, sid, hint)
                step_log.append(
                    f"Step {step:3d} [{hint['rule_name']}]:"
                    f" place {d} at r{r + 1}c{c + 1}"
                )

            else:
                n = hint["elimination_count"]
                _apply_hint_item(client, sid, hint)
                step_log.append(
                    f"Step {step:3d} [{hint['rule_name']}]:"
                    f" {hint['display_name']}"
                    f" — {n} elim{'s' if n != 1 else ''}"
                )

        pytest.fail(
            f"Not solved after {MAX_STEPS} steps.\n"
            + self._summary(step_log, archive_log, vc_log)
        )

    # ------------------------------------------------------------------
    # Reporting helpers
    # ------------------------------------------------------------------

    def _summary(
        self,
        step_log: list[str],
        archive_log: list[tuple[int, list[str], int]],
        vc_log: dict[str, bool],
    ) -> str:
        lines: list[str] = ["--- Step log ---"]
        lines.extend(step_log)
        if archive_log:
            lines.append("\n--- Archive fallbacks ---")
            for step, rules, n in archive_log:
                lines.append(f"  Step {step:3d}: {rules} ({n} elims)")
        vc_total = len(vc_log)
        vc_helped = sum(1 for v in vc_log.values() if v)
        lines.append(
            f"\n--- Virtual cage hints ---"
            f"\n  {vc_total} suggested,"
            f" {vc_helped} helped (narrowed candidates),"
            f" {vc_total - vc_helped} had no immediate effect"
        )
        return "\n".join(lines)

    def _report(
        self,
        steps: int,
        step_log: list[str],
        archive_log: list[tuple[int, list[str], int]],
        vc_log: dict[str, bool],
    ) -> None:
        summary = self._summary(step_log, archive_log, vc_log)
        # Replace Unicode minus sign with ASCII hyphen for Windows cp1252 compat.
        summary = summary.replace("\u2212", "-")
        print(f"\n=== Guardian 10 solved in {steps} steps ===\n")
        print(summary)
