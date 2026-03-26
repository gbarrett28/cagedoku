# Rules Config Pane — Design Spec

**Date:** 2026-03-26

## Overview

A modal dialog accessible from the top toolbar (left of the Quit Server button) that
lets the user toggle each hintable rule between **auto-apply** and **hint-only** mode.
Available at any time — including before a puzzle is loaded.

## Scope

Only rules that implement `HintableRule` (i.e. have `compute_hints()`) are shown.
The frontend hardcodes this list as a deliberate simplification — if rules are added
or removed, the frontend display names table below must be updated alongside.

Currently four rules qualify:

| Rule name | Default mode |
|---|---|
| CageCandidateFilter | auto-apply |
| SolutionMapFilter | hint-only |
| MustContainOutie | hint-only |
| CageConfinement | hint-only |

All rules are equal — none are locked or non-toggleable.

The initial value of `always_apply_rules` (when no settings file exists) is
`["CageCandidateFilter"]`, matching the existing `DEFAULT_ALWAYS_APPLY_RULES` constant.

### Rule display names

| Rule name (internal) | Display name |
|---|---|
| CageCandidateFilter | Cage Candidate Filter |
| SolutionMapFilter | Solution Map Filter |
| MustContainOutie | Must Contain Outie |
| CageConfinement | Cage Confinement |

## Backend

### Existing (no change needed)

- `GET /api/settings` — returns `CoachSettings` including `always_apply_rules: list[str]`
- `PATCH /api/settings` — accepts the full `CoachSettings` model and replaces the stored
  settings entirely; persists and returns the updated settings. (The existing endpoint
  uses PATCH by convention; implementers should not change the HTTP method.)

### New endpoint

```
POST /api/puzzle/{session_id}/refresh
```

Re-runs `_compute_candidate_grid(existing_grid=state.candidate_grid)` reading
always-apply rules from the persisted settings store (not from a request body) and
returns `PuzzleState`. No request body required. Passing `state.candidate_grid`
preserves all user-essential and user-removed overrides accumulated so far.

Returns 404 if the session is unknown. Returns 409 if the session exists but is not
yet confirmed (matching the convention used by all existing puzzle endpoints). Returns
the updated `PuzzleState` on success.

## Frontend

### Toolbar button

A **"Config"** button added to the top toolbar, immediately to the left of the Quit
Server button. Always visible regardless of puzzle state.

### Modal

Reuses the existing `<dialog>` pattern (same as the hint modal). Structure:

- Title: "Solver Rules"
- Body: a list of the four hintable rules, each row showing:
  - Rule display name
  - Two-option toggle: **Auto-apply** | **Hint-only**
- Footer: **Save** and **Cancel** buttons

When populating toggles from `always_apply_rules`, any rule name in the settings
response that is not in the hardcoded display-names table is silently ignored.

### Data flow

1. User clicks Config → `GET /api/settings` → populate toggles from `always_apply_rules`
2. User adjusts toggles (local state only — no requests yet)
3. **Save** → `PATCH /api/settings` with updated `always_apply_rules`
   - On `PATCH` failure: throw (surfaces to browser console); modal stays open
   - On `PATCH` success and `currentSessionId` is set: `POST /api/puzzle/{session_id}/refresh`
     → on refresh success: update `currentState` + `redrawGrid()`
     → on refresh failure: throw (surfaces to browser console); modal stays open so
       the user can retry or cancel (avoids leaving the board silently stale)
   - Close modal only after all requests succeed
4. **Cancel** → discard local state → close modal

`currentSessionId` is null when no puzzle is loaded (pre-upload or mid-upload), so
the refresh step is safely skipped in those states.

### Effect timing

- **Auto-apply rules**: the refresh call applies them immediately to the candidate grid
  on save, so the board updates without the user needing to do anything.
- **Hint-only rules**: take effect the next time the user opens the hints dropdown,
  since hint collection runs fresh on each request.

## Out of scope

- Per-session settings (settings are global/user-wide)
- Rules without `compute_hints()` — not shown in the config pane
- Rule ordering or priority adjustment
