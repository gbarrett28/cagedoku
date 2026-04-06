"""Tests for POST /puzzle/{id}/virtual-cages and GET /candidates virtual_cages.

Verifies:
  - Validation: 404/409/422 error cases
  - Successful addition: Turn recorded, candidates response includes the cage
  - Key canonicalisation (cells in any order → same key)
  - Duplicate detection
  - _user_virtual_cages is used (not state.virtual_cages) in get_candidates
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig
from killer_sudoku.api.routers.puzzle import (
    _spec_to_cage_states,
    _spec_to_data,
    _virtual_cage_key,
)
from killer_sudoku.api.schemas import PuzzleState
from killer_sudoku.api.session import SessionStore
from tests.api.test_hints import _make_g10_state
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
# Unit tests: _virtual_cage_key
# ---------------------------------------------------------------------------


class TestVirtualCageKey:
    def test_sorted_cells(self) -> None:
        assert _virtual_cage_key([(0, 3), (0, 0), (1, 2)], 17) == "0,0:0,3:1,2:17"

    def test_already_sorted(self) -> None:
        assert _virtual_cage_key([(0, 0), (0, 1)], 10) == "0,0:0,1:10"

    def test_reverse_order_matches_sorted(self) -> None:
        k1 = _virtual_cage_key([(1, 1), (0, 0)], 5)
        k2 = _virtual_cage_key([(0, 0), (1, 1)], 5)
        assert k1 == k2


# ---------------------------------------------------------------------------
# API tests: POST /virtual-cages — error cases
# ---------------------------------------------------------------------------


class TestAddVirtualCageErrors:
    def test_404_unknown_session(self, client: TestClient) -> None:
        resp = client.post(
            "/api/puzzle/does-not-exist/virtual-cages",
            json={"cells": [[0, 0], [0, 1]], "total": 10},
        )
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
        resp = client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0], [0, 1]], "total": 10},
        )
        assert resp.status_code == 409

    def test_422_single_cell(self, client: TestClient, store: SessionStore) -> None:
        sid, _ = _make_g10_state(store)
        resp = client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0]], "total": 3},
        )
        assert resp.status_code == 422

    def test_422_duplicate_cells(self, client: TestClient, store: SessionStore) -> None:
        sid, _ = _make_g10_state(store)
        resp = client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0], [0, 0]], "total": 3},
        )
        assert resp.status_code == 422

    def test_422_cell_out_of_range(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state(store)
        resp = client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0], [9, 0]], "total": 10},
        )
        assert resp.status_code == 422

    def test_422_total_too_low(self, client: TestClient, store: SessionStore) -> None:
        sid, _ = _make_g10_state(store)
        # 2-cell min is 1+2=3; total 2 is impossible
        resp = client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0], [0, 1]], "total": 2},
        )
        assert resp.status_code == 422

    def test_422_total_too_high(self, client: TestClient, store: SessionStore) -> None:
        sid, _ = _make_g10_state(store)
        # 2-cell max is 8+9=17; total 18 is impossible
        resp = client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0], [0, 1]], "total": 18},
        )
        assert resp.status_code == 422

    def test_409_duplicate_virtual_cage(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state(store)
        payload = {"cells": [[0, 0], [0, 1]], "total": 10}
        client.post(f"/api/puzzle/{sid}/virtual-cages", json=payload)
        # Second identical submission
        resp = client.post(f"/api/puzzle/{sid}/virtual-cages", json=payload)
        assert resp.status_code == 409


# ---------------------------------------------------------------------------
# API tests: POST /virtual-cages — success cases
# ---------------------------------------------------------------------------


class TestAddVirtualCageSuccess:
    def test_200_records_turn(self, client: TestClient, store: SessionStore) -> None:
        sid, _ = _make_g10_state(store)
        resp = client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0], [0, 1]], "total": 8},
        )
        assert resp.status_code == 200
        state = resp.json()
        # Turn recorded with add_virtual_cage action
        assert len(state["history"]) == 1
        assert state["history"][0]["user_action"]["type"] == "add_virtual_cage"

    def test_virtual_cage_key_in_turn(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state(store)
        # Submit cells in reverse order — key should still be canonical
        resp = client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 1], [0, 0]], "total": 8},
        )
        assert resp.status_code == 200
        action = resp.json()["history"][0]["user_action"]
        assert action["virtual_cage_key"] == "0,0:0,1:8"

    def test_candidates_includes_virtual_cage(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state(store)
        client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0], [0, 1]], "total": 8},
        )
        cands = client.get(f"/api/puzzle/{sid}/candidates")
        assert cands.status_code == 200
        vcs = cands.json()["virtual_cages"]
        assert len(vcs) == 1
        assert vcs[0]["total"] == 8
        # solutions for 2-cell total=8 with distinct digits: {1,7},{2,6},{3,5}
        assert len(vcs[0]["solutions"]) == 3

    def test_two_virtual_cages_both_appear(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state(store)
        client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0], [0, 1]], "total": 8},
        )
        client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[1, 0], [1, 1]], "total": 11},
        )
        vcs = client.get(f"/api/puzzle/{sid}/candidates").json()["virtual_cages"]
        assert len(vcs) == 2

    def test_must_contain_populated(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state(store)
        # 2-cell total=3: only solution is {1,2} → must_contain = [1,2]
        client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0], [0, 1]], "total": 3},
        )
        vc = client.get(f"/api/puzzle/{sid}/candidates").json()["virtual_cages"][0]
        assert vc["must_contain"] == [1, 2]

    def test_undo_removes_virtual_cage(
        self, client: TestClient, store: SessionStore
    ) -> None:
        sid, _ = _make_g10_state(store)
        client.post(
            f"/api/puzzle/{sid}/virtual-cages",
            json={"cells": [[0, 0], [0, 1]], "total": 8},
        )
        client.post(f"/api/puzzle/{sid}/undo")
        vcs = client.get(f"/api/puzzle/{sid}/candidates").json()["virtual_cages"]
        assert len(vcs) == 0
