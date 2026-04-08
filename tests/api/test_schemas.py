"""Tests for the Turn-based session schema (Slice 2 — Task 11)."""

from __future__ import annotations

from killer_sudoku.api.schemas import (
    AutoMutation,
    BoardSnapshot,
    PuzzleSpecData,
    PuzzleState,
    Turn,
    UserAction,
    VirtualCage,
)

_EMPTY_SPEC = PuzzleSpecData(
    regions=[[0] * 9 for _ in range(9)],
    cage_totals=[[0] * 9 for _ in range(9)],
    border_x=[[False] * 9 for _ in range(10)],
    border_y=[[False] * 10 for _ in range(9)],
)

_MIN_STATE = {
    "session_id": "test-session",
    "cages": [],
    "spec_data": _EMPTY_SPEC,
    "original_image_b64": "",
}


def test_puzzle_state_has_history() -> None:
    """PuzzleState.history defaults to empty list."""
    state = PuzzleState(**_MIN_STATE, history=[])
    assert state.history == []


def test_turn_roundtrip() -> None:
    """Turn serialises and deserialises correctly."""
    action = UserAction(type="place_digit", row=0, col=0, digit=5, source="user:manual")
    turn = Turn(user_action=action, auto_mutations=[], snapshot=None)
    data = turn.model_dump()
    turn2 = Turn.model_validate(data)
    assert turn2.user_action.digit == 5


def test_auto_mutation_candidate_removed() -> None:
    """AutoMutation round-trips for candidate_removed type."""
    mut = AutoMutation(
        rule_name="CageCandidateFilter",
        type="candidate_removed",
        row=3,
        col=4,
        digit=7,
    )
    assert AutoMutation.model_validate(mut.model_dump()).digit == 7


def test_board_snapshot_roundtrip() -> None:
    """BoardSnapshot serialises and deserialises a 9x9 candidate grid."""
    candidates = [[[1, 2, 3]] * 9 for _ in range(9)]
    cage_solns: list[list[list[int]]] = [[[1, 2, 3], [1, 2, 4]]]
    snap = BoardSnapshot(candidates=candidates, cage_solns=cage_solns)
    snap2 = BoardSnapshot.model_validate(snap.model_dump())
    assert snap2.candidates[0][0] == [1, 2, 3]
    assert snap2.cage_solns[0][1] == [1, 2, 4]


def test_virtual_cage_defaults() -> None:
    """VirtualCage.eliminated_solns defaults to empty list."""
    vc = VirtualCage(key="0,0:0,1:17", cells=[(0, 0), (0, 1)], total=17)
    assert vc.eliminated_solns == []


def test_puzzle_state_virtual_cages_default() -> None:
    """PuzzleState.virtual_cages defaults to empty list."""
    state = PuzzleState(**_MIN_STATE)
    assert state.virtual_cages == []
