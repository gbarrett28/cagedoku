# Rules Config Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Config modal accessible from the top toolbar that lets the user toggle each hintable rule between auto-apply and hint-only mode, with immediate effect on the active puzzle.

**Architecture:** New `POST /api/puzzle/{session_id}/refresh` backend endpoint re-applies always-apply rules using the current persisted settings. Frontend adds a Config button to the header and a `<dialog>` modal that reads/writes `/api/settings`, then calls `/refresh` if a puzzle is active.

**Tech Stack:** FastAPI (Python), Pydantic, TypeScript, HTML/CSS, pytest

---

## File Map

| File | Change |
|---|---|
| `killer_sudoku/api/routers/puzzle.py` | Add `POST /{session_id}/refresh` endpoint |
| `killer_sudoku/static/index.html` | Add config button to header; add config modal `<dialog>` |
| `killer_sudoku/static/main.ts` | Add config modal open/save/cancel logic |
| `killer_sudoku/static/styles.css` | Add styles for config modal rule rows |
| `tests/api/test_config_pane.py` | API tests for the refresh endpoint |

**TypeScript must be compiled after every `main.ts` edit:** `npx tsc`

**Bronze gate (run before every commit):**
```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff check --unsafe-fixes --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

---

## Task 1: Backend — POST /puzzle/{session_id}/refresh endpoint

**Files:**
- Modify: `killer_sudoku/api/routers/puzzle.py`
- Test: `tests/api/test_config_pane.py`
- Modify: `tests/api/test_hints.py` (add shared helper)

### Context

`_compute_candidate_grid` (puzzle.py:232) signature:
```python
def _compute_candidate_grid(
    state: PuzzleState,
    existing_grid: CandidateGrid | None,
    always_apply: frozenset[str],
) -> CandidateGrid:
```

Passing `state.candidate_grid` as `existing_grid` preserves all `user_essential` and
`user_removed` overrides. Passing `None` would discard them (used only at initial
`/confirm`).

Error conventions (from existing puzzle endpoints):
- 404 → `KeyError` from `store.load()` (session not found)
- 409 → `state.user_grid is None` (session not yet confirmed)

The undo endpoint (puzzle.py:~650) is the closest existing pattern to follow.

- [ ] **Step 1: Add `_make_g10_state` helper to test_hints.py**

`test_config_pane.py` needs to seed a confirmed guardian-10 state. Add this
module-level helper to `tests/api/test_hints.py` (after the existing imports).

**Critical:** `PuzzleState` has three required fields without defaults: `newspaper`,
`original_image_b64`, and `spec_data`. The `spec_data` field is a `PuzzleSpecData`
Pydantic model — NOT a raw dict. Use `_spec_to_data(spec)` (already imported in
`test_hints.py` from `killer_sudoku.api.routers.puzzle`) to build it correctly.

```python
def _make_g10_state(store: SessionStore) -> tuple[str, PuzzleState]:
    """Seed a confirmed guardian-10 state into store; return (session_id, state).

    Extracted from the g10_state fixture so other test modules can reuse it
    without depending on pytest fixture injection.
    """
    import uuid
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
```

- [ ] **Step 2: Write the failing tests in test_config_pane.py**

```python
"""Tests for POST /api/puzzle/{session_id}/refresh endpoint."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from killer_sudoku.api.app import create_app
from killer_sudoku.api.config import CoachConfig
from killer_sudoku.api.session import SessionStore
from killer_sudoku.api.schemas import PuzzleState
from tests.api.test_hints import _make_g10_state, _spec_to_cage_states, _spec_to_data
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
        cages = _spec_to_cage_states(spec)
        sid = str(uuid.uuid4())
        state = PuzzleState(
            session_id=sid,
            newspaper="guardian",
            cages=cages,
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
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
python -m pytest tests/api/test_config_pane.py -v
```

Expected: `404` or attribute errors (endpoint not yet defined).

- [ ] **Step 4: Add the refresh endpoint to puzzle.py**

**Critical:** All endpoints are defined as inner functions inside `make_router()` — the
`store` and `settings_store` variables are closure variables from that factory function.
The endpoint must be placed inside `make_router()`, after the `apply_hint` endpoint
(search for `"/{session_id}/hints/apply"` to find the insertion point).

```python
@router.post("/{session_id}/refresh", response_model=PuzzleState)
async def refresh(session_id: str) -> PuzzleState:
    """Re-apply always-apply rules using current settings; return updated state.

    Called by the frontend after saving settings to reflect newly enabled
    auto-apply rules on the active board immediately. Preserves all
    user_essential and user_removed overrides via existing_grid.
    """
    try:
        state = store.load(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found") from exc

    if state.user_grid is None:
        raise HTTPException(status_code=409, detail="Session not yet confirmed")

    always_apply = frozenset(settings_store.load().always_apply_rules)
    new_cg = _compute_candidate_grid(state, state.candidate_grid, always_apply)
    updated = state.model_copy(update={"candidate_grid": new_cg})
    store.save(updated)
    return updated
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
python -m pytest tests/api/test_config_pane.py -v
```

Expected: all 4 tests pass.

- [ ] **Step 6: Run full bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 7: Commit**

```bash
git add killer_sudoku/api/routers/puzzle.py tests/api/test_config_pane.py tests/api/test_hints.py
git commit -m "feat: add POST /puzzle/{session_id}/refresh endpoint"
```

---

## Task 2: Frontend HTML — Config button and modal

**Files:**
- Modify: `killer_sudoku/static/index.html`

### Context

Current header (index.html:11–17):
```html
<header>
  <div class="header-inner">
    <h1>COACH</h1>
    <span class="header-sub">Killer Sudoku Coaching App</span>
    <button id="quit-btn" class="btn-secondary btn-quit">Quit server</button>
  </div>
</header>
```

Existing modal pattern (index.html:145–153):
```html
<dialog id="hint-modal">
  <h2 id="hint-modal-title"></h2>
  ...
  <div class="form-actions">
    <button id="hint-apply-btn">Apply automatically</button>
    <button id="hint-close-btn" class="btn-secondary">Close &amp; apply by hand</button>
  </div>
</dialog>
```

- [ ] **Step 1: Add the Config button to the header**

Replace the header with:

```html
<header>
  <div class="header-inner">
    <h1>COACH</h1>
    <span class="header-sub">Killer Sudoku Coaching App</span>
    <button id="config-btn" class="btn-secondary">Config</button>
    <button id="quit-btn" class="btn-secondary btn-quit">Quit server</button>
  </div>
</header>
```

- [ ] **Step 2: Add the config modal dialog**

Add alongside the other modals (near hint-modal):

```html
<dialog id="config-modal">
  <h2>Solver Rules</h2>
  <div id="config-rules-list" class="config-rules-list"></div>
  <div class="form-actions">
    <button id="config-save-btn">Save</button>
    <button id="config-cancel-btn" class="btn-secondary">Cancel</button>
  </div>
</dialog>
```

The rule rows are built dynamically in TypeScript — no static content needed.

- [ ] **Step 3: Commit**

```bash
git add killer_sudoku/static/index.html
git commit -m "feat: add config button and modal dialog HTML"
```

---

## Task 3: Frontend CSS — Config modal styles

**Files:**
- Modify: `killer_sudoku/static/styles.css`

The base `dialog` styles (styles.css:388) apply automatically. Only the rule list
layout needs new styles.

- [ ] **Step 1: Add styles**

Add near the existing modal styles:

```css
/* Config modal — rule list */
.config-rules-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 1.25rem 0;
  min-width: 340px;
}

.config-rule-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.config-rule-name {
  font-size: 0.9rem;
  flex: 1;
}

.config-rule-select {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.3rem 0.5rem;
  font-size: 0.85rem;
  cursor: pointer;
}
```

- [ ] **Step 2: Commit**

```bash
git add killer_sudoku/static/styles.css
git commit -m "feat: add config modal CSS styles"
```

---

## Task 4: Frontend TypeScript — Config modal logic

**Files:**
- Modify: `killer_sudoku/static/main.ts`

### Context

Key existing patterns in `main.ts`:
- `el<T>(id)` — typed `document.getElementById` wrapper
- `clearChildren(el)` — empties a DOM element without innerHTML (use this, not innerHTML)
- `let currentSessionId: string | null = null;` (line ~113)
- `currentState = await resp.json(); redrawGrid();` — standard state-update pattern
- Modal: `(el<HTMLDialogElement>("id")).showModal()` / `.close()`
- Error surfacing: `throw new Error(...)` — lands in browser console

- [ ] **Step 1: Add RuleConfig interface and HINTABLE_RULES constant**

Add after existing interface declarations near the top of `main.ts`:

```typescript
interface RuleConfig {
  name: string;
  displayName: string;
}

const HINTABLE_RULES: RuleConfig[] = [
  { name: "CageCandidateFilter", displayName: "Cage Candidate Filter" },
  { name: "SolutionMapFilter", displayName: "Solution Map Filter" },
  { name: "MustContainOutie", displayName: "Must Contain Outie" },
  { name: "CageConfinement", displayName: "Cage Confinement" },
];
```

- [ ] **Step 2: Add openConfigModal function**

```typescript
async function openConfigModal(): Promise<void> {
  const res = await fetch("/api/settings");
  if (!res.ok) {
    throw new Error(`GET settings failed: ${res.status} ${await res.text()}`);
  }
  const settings = (await res.json()) as { always_apply_rules: string[] };
  const alwaysApplySet = new Set(settings.always_apply_rules);

  const list = el<HTMLElement>("config-rules-list");
  clearChildren(list);

  for (const rule of HINTABLE_RULES) {
    const row = document.createElement("div");
    row.className = "config-rule-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "config-rule-name";
    nameSpan.textContent = rule.displayName;

    const select = document.createElement("select");
    select.className = "config-rule-select";
    select.dataset["ruleName"] = rule.name;

    const optAuto = document.createElement("option");
    optAuto.value = "auto";
    optAuto.textContent = "Auto-apply";
    const optHint = document.createElement("option");
    optHint.value = "hint";
    optHint.textContent = "Hint-only";
    select.appendChild(optAuto);
    select.appendChild(optHint);
    select.value = alwaysApplySet.has(rule.name) ? "auto" : "hint";

    row.appendChild(nameSpan);
    row.appendChild(select);
    list.appendChild(row);
  }

  (el<HTMLDialogElement>("config-modal")).showModal();
}
```

- [ ] **Step 3: Add Config button, Save button, and Cancel button listeners**

```typescript
el<HTMLButtonElement>("config-btn").addEventListener("click", () => {
  void openConfigModal();
});

el<HTMLButtonElement>("config-save-btn").addEventListener("click", async () => {
  const selects = el<HTMLElement>("config-rules-list")
    .querySelectorAll<HTMLSelectElement>("select[data-rule-name]");
  const alwaysApplyRules: string[] = [];
  for (const select of selects) {
    if (select.value === "auto" && select.dataset["ruleName"]) {
      alwaysApplyRules.push(select.dataset["ruleName"]);
    }
  }

  const patchResp = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ always_apply_rules: alwaysApplyRules }),
  });
  if (!patchResp.ok) {
    throw new Error(
      `PATCH settings failed: ${patchResp.status} ${await patchResp.text()}`
    );
  }

  if (currentSessionId) {
    const refreshResp = await fetch(`/api/puzzle/${currentSessionId}/refresh`, {
      method: "POST",
    });
    if (!refreshResp.ok) {
      throw new Error(
        `POST refresh failed: ${refreshResp.status} ${await refreshResp.text()}`
      );
    }
    currentState = await refreshResp.json();
    redrawGrid();
  }

  (el<HTMLDialogElement>("config-modal")).close();
});

el<HTMLButtonElement>("config-cancel-btn").addEventListener("click", () => {
  (el<HTMLDialogElement>("config-modal")).close();
});
```

- [ ] **Step 4: Compile TypeScript**

```bash
npx tsc
```

Expected: no errors. Fix any type errors before proceeding.

- [ ] **Step 5: Run full bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 6: Commit**

```bash
git add killer_sudoku/static/main.ts killer_sudoku/static/main.js
git commit -m "feat: add config modal TypeScript logic"
```

---

## Task 5: Manual integration test

- [ ] **Step 1: Start the server**

```bash
python -m killer_sudoku.api
```

- [ ] **Step 2: Run through the full flow**

1. Open `http://127.0.0.1:8000` — verify Config button appears left of Quit Server
2. Click Config before loading a puzzle — verify modal opens with four rules,
   CageCandidateFilter as Auto-apply, others as Hint-only
3. Click Cancel — verify modal closes, no request made
4. Load and confirm a puzzle
5. Click Config, toggle SolutionMapFilter to Auto-apply, click Save —
   verify board redraws and console shows no errors
6. Click Config again — verify SolutionMapFilter still shows Auto-apply
7. Toggle SolutionMapFilter back to Hint-only, click Save

- [ ] **Step 3: Commit any fixup changes**

```bash
git add killer_sudoku/static/main.ts killer_sudoku/static/main.js \
        killer_sudoku/static/index.html killer_sudoku/static/styles.css
git commit -m "fix: config pane integration fixups"
```
