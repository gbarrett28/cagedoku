"""Tests for POST /api/puzzle/{session_id}/refresh endpoint."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig
from killer_sudoku.api.routers.puzzle import _spec_to_cage_states, _spec_to_data
from killer_sudoku.api.schemas import PuzzleState
from killer_sudoku.api.session import SessionStore
from tests.api.test_hints import _make_g10_state
from tests.fixtures.guardian10_puzzle import make_guardian10_spec


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


class TestRefreshEndpoint:
    def test_404_unknown_session(self, client: TestClient) -> None:
        resp = client.post("/api/puzzle/does-not-exist/refresh")
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
        resp = client.post(f"/api/puzzle/{sid}/refresh")
        assert resp.status_code == 409

    def test_200_returns_puzzle_state(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _state = _make_g10_state(store)
        resp = client.post(f"/api/puzzle/{sid}/refresh")
        assert resp.status_code == 200
        data = resp.json()
        assert data["session_id"] == sid
        assert data["candidate_grid"] is not None

    def test_refresh_reflects_settings(
        self, client: TestClient, store: SessionStore
    ) -> None:
        """Enabling a new always-apply rule via settings then refreshing succeeds."""
        sid, _state = _make_g10_state(store)
        client.patch(
            "/api/settings",
            json={"always_apply_rules": ["CageCandidateFilter", "SolutionMapFilter"]},
        )
        resp = client.post(f"/api/puzzle/{sid}/refresh")
        assert resp.status_code == 200
        assert resp.json()["candidate_grid"] is not None
