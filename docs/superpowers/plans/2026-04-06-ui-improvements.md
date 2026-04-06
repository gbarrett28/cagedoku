# UI Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the seven known UI issues listed in `docs/ui.md` plus the general app help modal.

**Architecture:** All changes are split between a thin backend layer (adding `description` and `show_essential` to the settings API) and the TypeScript frontend. No new endpoints are needed beyond what already exists.

**Tech Stack:** Python 3.13, FastAPI, Pydantic, TypeScript, HTML/CSS

**Spec:** `docs/ui.md`, `docs/architecture.md` (Coaching App section)

**Bronze gate (run before every commit):**
```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff check --unsafe-fixes --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

---

## File Map

| File | Change |
|---|---|
| `killer_sudoku/api/schemas.py` | Add `description: str` to `RuleInfo`; add `show_essential: bool` to `CoachSettings` |
| `killer_sudoku/api/settings.py` | Persist `show_essential`; return it from `GET /api/settings` |
| `killer_sudoku/solver/engine/rules/_registry.py` | Add `description` class attribute to `hintable_rule` protocol / registry |
| `killer_sudoku/solver/engine/rules/*.py` | Add `description` string to each hintable rule class |
| `killer_sudoku/static/index.html` | Add rule-info modal, general-help modal, collapse upload panel |
| `killer_sudoku/static/main.ts` | Implement all frontend changes |
| `killer_sudoku/static/styles.css` | Style additions for new modals and info button |
| `tests/api/test_settings.py` | Extend to cover `description` and `show_essential` |

---

### Task 1: Add `description` to `RuleInfo` and each rule

**Files:**
- Modify: `killer_sudoku/api/schemas.py`
- Modify: `killer_sudoku/solver/engine/rules/_registry.py`
- Modify: each hintable rule file in `killer_sudoku/solver/engine/rules/`
- Modify: `tests/api/test_settings.py`

- [ ] **Step 1: Write failing test**

In `tests/api/test_settings.py`, add:

```python
def test_settings_rules_have_descriptions(client: TestClient) -> None:
    resp = client.get("/api/settings")
    assert resp.status_code == 200
    rules = resp.json()["rules"]
    assert len(rules) > 0
    for rule in rules:
        assert "description" in rule
        assert isinstance(rule["description"], str)
        assert len(rule["description"]) > 10, f"Rule {rule['name']} has trivial description"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
python -m pytest tests/api/test_settings.py::test_settings_rules_have_descriptions -v
```
Expected: FAIL — `description` key not found.

- [ ] **Step 3: Add `description` to `RuleInfo` schema**

In `killer_sudoku/api/schemas.py`, update:

```python
class RuleInfo(BaseModel):
    name: str
    display_name: str
    description: str
```

- [ ] **Step 4: Add `description` class attribute to the hintable rule protocol**

In `killer_sudoku/solver/engine/rules/_registry.py`, locate the `hintable_rule`
decorator / registry mechanism. Add `description: str` as a required class
attribute that must be present on every decorated rule class. The exact form
depends on whether it uses a Protocol or a base class — read the file first.

- [ ] **Step 5: Add `description` to each hintable rule**

Read `killer_sudoku/solver/engine/rules/__init__.py` to get the list of active
rules. For each rule file in `killer_sudoku/solver/engine/rules/` (not
`incomplete/`), add a `description: str` class attribute. Use the following
texts:

| Rule class | Description |
|---|---|
| `NakedSingle` | `"When a cell has only one remaining candidate, that digit must go there. Also removes it from peer cells in the same row, column, and box."` |
| `CellSolutionElimination` | `"When a cell is solved, removes that digit from all other cells in the same row, column, and box."` |
| `HiddenSingle` | `"When a digit can go in only one cell in a row, column, box, or cage, it must go there."` |
| `LinearElimination` | `"Uses linear equations derived from cage sums to eliminate impossible digit values from cells."` |
| `CageCandidateFilter` | `"Narrows each cell's candidates to digits that appear in at least one valid solution for that cell's cage."` |
| `CageIntersection` | `"When a cage's required digit is confined to cells that all lie in one row, column, or box, that digit can be removed from other cells in that unit."` |
| `SolutionMapFilter` | `"Removes cage solutions that are now impossible because one of their digits has been eliminated from the relevant cell."` |
| `MustContain` | `"When a digit must appear in a cage and is confined to cells that overlap another unit, it can be eliminated from that unit's other cells."` |
| `MustContainOutie` | `"Extension of must-contain: when a digit required by a cage can only be placed in cells shared with an adjacent cage, constrains the adjacent cage."` |
| `DeltaConstraint` | `"When two cells differ by a known constant (derived from overlapping row/column sums), restricts both cells' candidates to valid pairs."` |
| `SumPairConstraint` | `"When two cells sum to a known constant, restricts both to valid complementary pairs."` |
| `NakedPair` | `"When exactly two cells in a unit share the same two candidates and no others, those digits can be removed from all other cells in that unit."` |
| `PointingPairs` | `"When a digit in a box is confined to one row or column, it can be removed from other cells in that row or column outside the box."` |
| `LockedCandidates` | `"When a digit in a row or column is confined to one box, it can be removed from other cells in that box."` |
| `CageConfinement` | `"Checks all groups of cages that together cover complete rows, columns, or boxes, and eliminates digits inconsistent with the resulting sum constraints."` |
| `UnitPartitionFilter` | `"When cages partition a row, column, or box into known-sum groups, eliminates cage solutions inconsistent with those groups."` |

- [ ] **Step 6: Update settings endpoint to include `description`**

In `killer_sudoku/api/settings.py` (or wherever `GET /api/settings` builds its
rule list), change the `RuleInfo` construction to include
`description=rule.description`.

- [ ] **Step 7: Run test to verify it passes**

```bash
python -m pytest tests/api/test_settings.py::test_settings_rules_have_descriptions -v
```
Expected: PASS.

- [ ] **Step 8: Run bronze gate**

```bash
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v
```

- [ ] **Step 9: Commit**

```bash
git add killer_sudoku/api/schemas.py killer_sudoku/api/settings.py \
        killer_sudoku/solver/engine/rules/ tests/api/test_settings.py
git commit -m "feat: add description field to RuleInfo and each hintable rule"
```

---

### Task 2: Add `show_essential` to settings

**Files:**
- Modify: `killer_sudoku/api/schemas.py`
- Modify: `killer_sudoku/api/settings.py`
- Modify: `tests/api/test_settings.py`

- [ ] **Step 1: Write failing test**

```python
def test_show_essential_defaults_true(client: TestClient) -> None:
    resp = client.get("/api/settings")
    assert resp.status_code == 200
    assert resp.json()["show_essential"] is True

def test_show_essential_can_be_toggled(client: TestClient) -> None:
    resp = client.patch("/api/settings", json={"show_essential": False})
    assert resp.status_code == 200
    resp2 = client.get("/api/settings")
    assert resp2.json()["show_essential"] is False
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest tests/api/test_settings.py::test_show_essential_defaults_true \
                 tests/api/test_settings.py::test_show_essential_can_be_toggled -v
```

- [ ] **Step 3: Add `show_essential` to `CoachSettings`**

In `killer_sudoku/api/schemas.py`:

```python
class CoachSettings(BaseModel):
    always_apply_rules: list[str] = Field(default_factory=list)
    show_essential: bool = True
```

Update `SettingsResponse` to include `show_essential: bool`.

Update `SettingsPatch` (the PATCH request model) to include
`show_essential: bool | None = None`.

- [ ] **Step 4: Update `SettingsStore` to persist and return `show_essential`**

In `killer_sudoku/api/settings.py`, update `load` and `save` to handle the new
field, and update the PATCH handler to apply `show_essential` when provided.

- [ ] **Step 5: Run tests to verify they pass**

- [ ] **Step 6: Run bronze gate and commit**

```bash
git add killer_sudoku/api/schemas.py killer_sudoku/api/settings.py tests/api/test_settings.py
git commit -m "feat: add show_essential toggle to CoachSettings"
```

---

### Task 3: Rule info (i) modal — frontend

**Files:**
- Modify: `killer_sudoku/static/index.html`
- Modify: `killer_sudoku/static/main.ts`
- Modify: `killer_sudoku/static/styles.css`

- [ ] **Step 1: Update `RuleInfo` TypeScript interface**

In `main.ts`, update:

```typescript
interface RuleInfo {
  name: string;
  display_name: string;
  description: string;
}
```

- [ ] **Step 2: Add rule-info modal to `index.html`**

After the `#config-modal` closing tag, add:

```html
<dialog id="rule-info-modal">
  <h2 id="rule-info-title"></h2>
  <p id="rule-info-description"></p>
  <div class="form-actions">
    <button id="rule-info-close-btn" class="btn-secondary">Close</button>
  </div>
</dialog>
```

- [ ] **Step 3: Add (i) button rendering to `openConfigModal`**

In `main.ts`, find the function that builds the config rule list (populates
`#config-rules-list`). For each rule row, append an info button:

```typescript
const infoBtn = document.createElement("button");
infoBtn.className = "btn-rule-info";
infoBtn.textContent = "ⓘ";
infoBtn.title = "About this rule";
infoBtn.addEventListener("click", () => {
  el<HTMLHeadingElement>("rule-info-title").textContent = rule.display_name;
  el<HTMLParagraphElement>("rule-info-description").textContent = rule.description;
  el<HTMLDialogElement>("rule-info-modal").showModal();
});
row.appendChild(infoBtn);
```

- [ ] **Step 4: Wire close button**

```typescript
el<HTMLButtonElement>("rule-info-close-btn").addEventListener("click", () => {
  el<HTMLDialogElement>("rule-info-modal").close();
});
```

- [ ] **Step 5: Add styles for `.btn-rule-info`**

In `styles.css`, add:

```css
.btn-rule-info {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  color: var(--accent);
  padding: 0 0.25rem;
  line-height: 1;
}
.btn-rule-info:hover { opacity: 0.7; }
```

- [ ] **Step 6: Compile TypeScript**

```bash
tsc
```
Expected: no errors.

- [ ] **Step 7: Run bronze gate**

- [ ] **Step 8: Commit**

```bash
git add killer_sudoku/static/index.html killer_sudoku/static/main.ts \
        killer_sudoku/static/styles.css
git commit -m "feat: add (i) info modal per rule in config pane"
```

---

### Task 4: Essential highlight toggle — frontend

**Files:**
- Modify: `killer_sudoku/static/index.html`
- Modify: `killer_sudoku/static/main.ts`

- [ ] **Step 1: Add `show_essential` to settings state**

In `main.ts`, add module-level variable:

```typescript
let showEssential: boolean = true;
```

- [ ] **Step 2: Update `SettingsResponse` TypeScript interface**

```typescript
interface SettingsResponse {
  always_apply_rules: string[];
  show_essential: boolean;
  rules: RuleInfo[];
}
```

- [ ] **Step 3: Add toggle to config modal HTML**

In `index.html`, inside `#config-modal` before the rule list, add:

```html
<div class="form-row">
  <label class="field-label" for="essential-toggle">Essential digit highlight</label>
  <input type="checkbox" id="essential-toggle" checked>
</div>
```

- [ ] **Step 4: Populate and save the toggle in `openConfigModal`**

When opening the modal, set the checkbox state from `showEssential`.
When saving, include `show_essential` in the PATCH body:

```typescript
const essentialToggle = el<HTMLInputElement>("essential-toggle");
essentialToggle.checked = showEssential;

// In save handler:
const body: Record<string, unknown> = {
  always_apply_rules: checkedRules,
  show_essential: essentialToggle.checked,
};
```

- [ ] **Step 5: Apply `show_essential` from settings response**

When `openConfigModal` loads settings, update `showEssential` and refresh
the grid:

```typescript
showEssential = data.show_essential;
```

- [ ] **Step 6: Pass `showEssential` to `drawGrid`**

Add `showEssential: boolean = true` parameter to `drawGrid`. In the candidate
rendering layer, replace the hard-coded salmon colour with:

```typescript
const isEssential = /* existing essential check */;
ctx.fillStyle = (isEssential && showEssential) ? "#cc5a45" : "#888";
```

Update all `drawGrid` call sites to pass `showEssential`.

- [ ] **Step 7: Compile, run bronze gate, commit**

```bash
tsc
git add killer_sudoku/static/index.html killer_sudoku/static/main.ts
git commit -m "feat: essential highlight toggle in config modal"
```

---

### Task 5: Collapse upload panel after successful processing

**Files:**
- Modify: `killer_sudoku/static/main.ts`
- Modify: `killer_sudoku/static/index.html`

- [ ] **Step 1: Add "New puzzle" button to header**

In `index.html`, add a button to the header that is hidden until a puzzle is
loaded, then reloads the page:

```html
<button id="new-puzzle-btn" class="btn-secondary" hidden>New puzzle</button>
```
Place it between the `#config-btn` and `#quit-btn`.

- [ ] **Step 2: Hide upload panel and show new-puzzle button on success**

In `handleProcess` (in `main.ts`), after successfully showing the review panel,
add:

```typescript
el<HTMLElement>("upload-panel").hidden = true;
el<HTMLButtonElement>("new-puzzle-btn").hidden = false;
```

- [ ] **Step 3: Wire new-puzzle button**

```typescript
el<HTMLButtonElement>("new-puzzle-btn").addEventListener("click", () => {
  window.location.reload();
});
```

- [ ] **Step 4: Compile, run bronze gate, commit**

```bash
tsc
git add killer_sudoku/static/index.html killer_sudoku/static/main.ts
git commit -m "feat: collapse upload panel after successful image processing"
```

---

### Task 6: Arrow key navigation

**Files:**
- Modify: `killer_sudoku/static/main.ts`

- [ ] **Step 1: Add arrow key handling to the keydown handler**

In `main.ts`, find the `keydown` event listener. Before the digit-entry block,
add:

```typescript
const arrowDeltas: Record<string, [number, number]> = {
  ArrowUp:    [-1,  0],
  ArrowDown:  [ 1,  0],
  ArrowLeft:  [ 0, -1],
  ArrowRight: [ 0,  1],
};
if (key in arrowDeltas && selectedCell !== null) {
  e.preventDefault();
  const [dr, dc] = arrowDeltas[key];
  // selectedCell uses 1-based rows/cols
  selectedCell = {
    row: ((selectedCell.row - 1 + dr + 9) % 9) + 1,
    col: ((selectedCell.col - 1 + dc + 9) % 9) + 1,
  };
  redrawGrid();
  return;
}
```

This must only fire when in playing mode (i.e., `selectedCell !== null`).

- [ ] **Step 2: Compile, run bronze gate, commit**

```bash
tsc
git add killer_sudoku/static/main.ts
git commit -m "feat: arrow key navigation between cells"
```

---

### Task 7: Fix virtual cage total input conflict

**Files:**
- Modify: `killer_sudoku/static/main.ts`

- [ ] **Step 1: Guard digit entry against focused total input**

In `main.ts`, find the `keydown` handler. At the top of the handler (before any
digit-entry or arrow logic), add a guard:

```typescript
const activeEl = document.activeElement;
if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
  return;  // let the input field handle the key
}
```

This prevents the grid handler from firing when any input has focus, including
`#vc-total-input`.

- [ ] **Step 2: Compile, run bronze gate, commit**

```bash
tsc
git add killer_sudoku/static/main.ts
git commit -m "fix: suppress cell digit entry when a form input has focus"
```

---

### Task 8: Fix candidate cycling — remove essential state from cycle

**Files:**
- Modify: `killer_sudoku/static/main.ts`

- [ ] **Step 1: Locate `handleCandidateCycle`**

Find the function that handles clicking a candidate sub-cell digit in edit mode.
It currently cycles: inessential → essential → impossible → inessential.

- [ ] **Step 2: Remove essential from the cycle**

Change the cycle to: possible → impossible → possible. The essential display
state is read-only (derived from `auto_essential` in the candidates response).

The POST to `/api/puzzle/{id}/candidates/cell` sends `{ row, col, digit, action }`.
The action should only ever be `"remove"` or `"restore"` — never `"promote"`.

Remove any branch that sends `action: "promote"` or sets the essential state.

- [ ] **Step 3: Compile, run bronze gate, commit**

```bash
tsc
git add killer_sudoku/static/main.ts
git commit -m "fix: candidate cycle is possible/impossible only — essential is read-only"
```

---

### Task 9: Fix undo — redraw grid after undo response

**Files:**
- Modify: `killer_sudoku/static/main.ts`

- [ ] **Step 1: Find the undo handler**

Locate the function wired to `#undo-btn`. It posts to `/api/puzzle/{id}/undo`.

- [ ] **Step 2: Update state and redraw after undo response**

The undo endpoint returns the updated `PuzzleState`. Ensure the handler:

```typescript
const data: PuzzleState = await resp.json();
currentState = data;
// Refresh candidates then redraw
await refreshCandidates();
redrawGrid();
```

If `refreshCandidates` already calls `redrawGrid`, calling it separately is not
needed — read the function before adding the call.

- [ ] **Step 3: Compile, run bronze gate, commit**

```bash
tsc
git add killer_sudoku/static/main.ts
git commit -m "fix: redraw grid and refresh candidates after undo"
```

---

### Task 10: General app help modal

**Files:**
- Modify: `killer_sudoku/static/index.html`
- Modify: `killer_sudoku/static/main.ts`
- Modify: `killer_sudoku/static/styles.css`

- [ ] **Step 1: Add help button to header**

In `index.html`, add to the `#header-inner` div before `#config-btn`:

```html
<button id="help-btn" class="btn-secondary">Help</button>
```

- [ ] **Step 2: Add general help modal to `index.html`**

After the `#hint-modal` closing tag:

```html
<dialog id="general-help-modal">
  <h2>Using COACH</h2>

  <h3>What COACH does</h3>
  <p>COACH reads a photo of a killer sudoku puzzle, detects the cage layout and
  totals, and then guides you through solving it using logical deduction rules.
  It never guesses — every suggestion is a logically valid elimination or
  placement.</p>

  <h3>Phases</h3>
  <ol>
    <li><strong>Upload</strong> — Select the newspaper and photo.  Press
    <em>Process image</em>.  COACH detects the grid and reads the cage totals.</li>
    <li><strong>Review</strong> — Check the detected layout against the original
    photo.  Correct any misread cage totals.  Press <em>Looks correct — solve!</em>
    when ready.</li>
    <li><strong>Playing</strong> — Enter digits, use hints, and track candidates
    until the puzzle is solved.</li>
  </ol>

  <h3>Candidates</h3>
  <p>Press <strong>Show candidates</strong> to see, for each unsolved cell, which
  digits are still possible.  A salmon digit is <em>essential</em> — it must appear
  in every valid solution for that cage.  Press <strong>?</strong> for full
  candidates help.</p>

  <h3>Hints</h3>
  <p>Press <strong>Hints</strong> to see what logical deductions are currently
  available.  Each hint explains the rule it used and what it eliminates.  You can
  apply the hint automatically or work through it by hand.</p>

  <h3>Always-apply rules</h3>
  <p>Open <strong>Config</strong> to choose which rules run automatically after
  every move.  Rules left as hint-only appear in the Hints list instead.  Press
  the <strong>ⓘ</strong> button next to any rule for an explanation.</p>

  <h3>Virtual cages</h3>
  <p>When a set of cells must sum to a known value (deduced from row/column/box
  arithmetic), press <strong>Virtual cage</strong>, click the cells, and enter the
  total.  The app will track solutions for this cage and use it in future hints.</p>

  <h3>Keyboard shortcuts</h3>
  <table>
    <tr><th>Key</th><th>Action</th></tr>
    <tr><td>1–9</td><td>Place digit in selected cell</td></tr>
    <tr><td>Delete / Backspace</td><td>Clear selected cell (or reset candidates in edit mode)</td></tr>
    <tr><td>Arrow keys</td><td>Move cell selection</td></tr>
  </table>

  <div class="form-actions">
    <button id="general-help-close-btn" class="btn-secondary">Close</button>
  </div>
</dialog>
```

- [ ] **Step 3: Wire buttons in `main.ts`**

```typescript
el<HTMLButtonElement>("help-btn").addEventListener("click", () => {
  el<HTMLDialogElement>("general-help-modal").showModal();
});
el<HTMLButtonElement>("general-help-close-btn").addEventListener("click", () => {
  el<HTMLDialogElement>("general-help-modal").close();
});
```

- [ ] **Step 4: Compile, run full bronze gate, commit**

```bash
tsc
python -m ruff check --fix --ignore PLR0912,PLR0915,C901 killer_sudoku/ tests/
python -m ruff format killer_sudoku/ tests/
python -m mypy --strict killer_sudoku/
python -m pytest tests/ -v
git add killer_sudoku/static/index.html killer_sudoku/static/main.ts \
        killer_sudoku/static/styles.css
git commit -m "feat: add general app help modal"
```

---

### Task 11: Silver gate and push

- [ ] **Step 1: Silver gate**

```bash
python -m ruff check killer_sudoku/
python -m mypy --strict killer_sudoku/
```

- [ ] **Step 2: Full test suite**

```bash
python -m pytest tests/ -v --cov=killer_sudoku --cov-report=term
```

- [ ] **Step 3: Push**

```bash
git push origin <branch>
```
