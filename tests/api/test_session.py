"""Tests for the JSON-backed SessionStore."""

from __future__ import annotations

from pathlib import Path

import pytest

from killer_sudoku.api.schemas import (
    CageState,
    CellPosition,
    PuzzleSpecData,
    PuzzleState,
)
from killer_sudoku.api.session import SessionStore


def _minimal_state(session_id: str = "test-session-abc") -> PuzzleState:
    """Return a minimal PuzzleState suitable for round-trip testing."""
    return PuzzleState(
        session_id=session_id,
        newspaper="guardian",
        cages=[
            CageState(
                label="A",
                total=5,
                cells=[CellPosition(row=1, col=1)],
            )
        ],
        spec_data=PuzzleSpecData(
            regions=[
                [1 if c == 0 and r == 0 else 0 for c in range(9)] for r in range(9)
            ],
            cage_totals=[
                [5 if c == 0 and r == 0 else 0 for c in range(9)] for r in range(9)
            ],
            border_x=[[True] * 8 for _ in range(9)],
            border_y=[[True] * 9 for _ in range(8)],
        ),
        original_image_b64="dGVzdA==",  # base64("test")
    )


class TestSessionStoreRoundTrip:
    """Save and load must preserve all PuzzleState fields exactly."""

    def test_session_id_preserved(self, tmp_path: Path) -> None:
        store = SessionStore(tmp_path / "sessions")
        state = _minimal_state("my-unique-id")
        store.save(state)
        assert store.load("my-unique-id").session_id == "my-unique-id"

    def test_cage_total_preserved(self, tmp_path: Path) -> None:
        store = SessionStore(tmp_path / "sessions")
        state = _minimal_state()
        store.save(state)
        assert store.load(state.session_id).cages[0].total == 5

    def test_original_image_b64_preserved(self, tmp_path: Path) -> None:
        store = SessionStore(tmp_path / "sessions")
        state = _minimal_state()
        store.save(state)
        assert store.load(state.session_id).original_image_b64 == "dGVzdA=="

    def test_spec_data_regions_preserved(self, tmp_path: Path) -> None:
        store = SessionStore(tmp_path / "sessions")
        state = _minimal_state()
        store.save(state)
        loaded = store.load(state.session_id)
        assert loaded.spec_data.regions == state.spec_data.regions


class TestSessionStoreErrors:
    """Error handling for missing or invalid sessions."""

    def test_load_missing_raises_key_error(self, tmp_path: Path) -> None:
        store = SessionStore(tmp_path / "sessions")
        with pytest.raises(KeyError, match="nonexistent"):
            store.load("nonexistent")

    def test_exists_false_before_save(self, tmp_path: Path) -> None:
        store = SessionStore(tmp_path / "sessions")
        assert store.exists("any-id") is False

    def test_exists_true_after_save(self, tmp_path: Path) -> None:
        store = SessionStore(tmp_path / "sessions")
        state = _minimal_state()
        store.save(state)
        assert store.exists(state.session_id) is True

    def test_exists_false_for_different_id(self, tmp_path: Path) -> None:
        store = SessionStore(tmp_path / "sessions")
        store.save(_minimal_state("id-one"))
        assert store.exists("id-two") is False


class TestSessionStoreLifecycle:
    """Directory creation and multi-session behaviour."""

    def test_sessions_dir_not_created_on_init(self, tmp_path: Path) -> None:
        sessions_dir = tmp_path / "sessions"
        SessionStore(sessions_dir)
        assert not sessions_dir.exists()

    def test_sessions_dir_created_on_first_save(self, tmp_path: Path) -> None:
        sessions_dir = tmp_path / "sessions"
        store = SessionStore(sessions_dir)
        store.save(_minimal_state())
        assert sessions_dir.exists()

    def test_save_overwrites_previous_state(self, tmp_path: Path) -> None:
        store = SessionStore(tmp_path / "sessions")
        state = _minimal_state()
        store.save(state)
        updated = state.model_copy(
            update={
                "cages": [
                    CageState(label="A", total=99, cells=[CellPosition(row=1, col=1)])
                ]
            }
        )
        store.save(updated)
        assert store.load(state.session_id).cages[0].total == 99

    def test_multiple_sessions_are_independent(self, tmp_path: Path) -> None:
        store = SessionStore(tmp_path / "sessions")
        store.save(_minimal_state("session-alpha"))
        store.save(_minimal_state("session-beta"))
        assert store.load("session-alpha").session_id == "session-alpha"
        assert store.load("session-beta").session_id == "session-beta"

    def test_session_files_written_as_json(self, tmp_path: Path) -> None:
        sessions_dir = tmp_path / "sessions"
        store = SessionStore(sessions_dir)
        state = _minimal_state("check-file")
        store.save(state)
        json_file = sessions_dir / "check-file.json"
        assert json_file.exists()
        content = json_file.read_text(encoding="utf-8")
        assert '"session_id"' in content
        assert '"check-file"' in content
