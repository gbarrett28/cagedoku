"""Tests for GET/PATCH /api/settings endpoints."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    config = CoachConfig(
        guardian_dir=tmp_path / "guardian",
        observer_dir=tmp_path / "observer",
        sessions_dir=tmp_path / "sessions",
    )
    return TestClient(create_app(config))


def test_settings_rules_have_descriptions(client: TestClient) -> None:
    resp = client.get("/api/settings")
    assert resp.status_code == 200
    rules = resp.json()["hintable_rules"]
    assert len(rules) > 0
    for rule in rules:
        assert "description" in rule, f"Rule {rule['name']} missing description"
        assert isinstance(rule["description"], str)
        assert len(rule["description"]) > 10, (
            f"Rule {rule['name']} has trivial description"
        )


def test_show_essential_defaults_true(client: TestClient) -> None:
    resp = client.get("/api/settings")
    assert resp.status_code == 200
    assert resp.json()["show_essential"] is True


def test_show_essential_can_be_toggled(client: TestClient) -> None:
    resp = client.patch("/api/settings", json={"show_essential": False})
    assert resp.status_code == 200
    resp2 = client.get("/api/settings")
    assert resp2.json()["show_essential"] is False
