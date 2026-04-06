# Partial Result Display on OCR Validation Error

**Date:** 2026-04-06
**Branch:** feature/format-agnostic-border-detection

---

## Problem

When `validate_cage_layout` (or the cage-total sum check) raises inside
`InpImage.__init__`, the partially-constructed `InpImage` object is discarded and
the API returns HTTP 422 with only an error string.  The user cannot see what the
pipeline actually detected — making it impossible to diagnose whether the borders,
the cage totals, or both are wrong.

---

## Goal

When image processing partially succeeds (borders and cage totals extracted, but
layout validation fails), the UI should show:

- The full interactive confirmation screen (border-toggle, cage-total editing) with
  the detected — possibly incorrect — layout.
- A prominent warning banner explaining the validation error.
- Two reference images: the original uploaded photo **and** the perspective-corrected
  (warped) grid.

The two-image display applies to **every** upload (not just error cases) since both
images are useful during the review phase.

---

## Architecture

### Non-raising constructor in `InpImage`

`InpImage.__init__` currently raises `ValueError` or `ProcessingError` for three
distinct failure modes — all of which occur **after** border detection has succeeded:

| Failure | Data available |
|---------|----------------|
| `_build_cage_totals` → "too many digits" | `border_x`, `border_y` |
| Sum range check (totals sum ≠ 405 ± 45) | `border_x`, `border_y`, `cage_totals` |
| `validate_cage_layout` → invalid cage | `border_x`, `border_y`, `cage_totals` |

The new contract: **`__init__` never raises for these three cases.** Instead it sets:

```python
self.spec: PuzzleSpec | None       # None on failure
self.spec_error: str | None        # message on failure; None on success
```

`AssertionError` from `locate_grid` (grid corners not found) still propagates — the
pipeline has not produced any useful data in that case.

`self.info.cage_totals` is initialised to a zero array before the try block, so it
is always valid (zero = no totals detected) even when `_build_cage_totals` fails.

### Warped image

`InpImage.__init__` already warps the grayscale and binary images using the
perspective matrix `m`.  A colour warped image is computed in the same step and
stored as:

```python
self.warped_img: npt.NDArray[np.uint8]  # BGR, shape (resolution, resolution, 3)
```

In the cache path (`rework=False`, `.jpk` exists), `m` is recomputed from the
stored `self.info.grid` corners and `self.warped_img` is computed the same way.

### Diagnostic spec

When `inp.spec_error` is set, the API builds a **diagnostic `PuzzleSpec`** using
the same union-find connected-components logic as `validate_cage_layout` but
**without validation checks** (invalid cages are silently included as-is).  Region
IDs are assigned sequentially; cage totals are taken verbatim from
`inp.info.cage_totals`.

A private helper `_build_diagnostic_spec(cage_totals, border_x, border_y)`
in `puzzle.py` implements this.

### API response changes

`UploadResponse` gains two new optional fields:

```python
warning: str | None = None           # validation error message; None on success
warped_image_b64: str | None = None  # always populated by the upload endpoint
```

`warped_image_b64` is **not** stored in `PuzzleState` (and therefore not persisted
in the session JSON) since sessions have no reload path and image data is large.

### Frontend changes

**`index.html`:** Add a "Warped Grid" `<img id="warped-img">` column inside
`#images-row`, immediately after "Original Photo".

**`main.ts`:**
- `UploadResponse` interface: add `warning?: string` and `warped_image_b64?: string`.
- In `handleProcess`: after a successful response, set `warped-img.src` from
  `data.warped_image_b64`; if `data.warning` is present, call
  `setStatus(data.warning, false)` (informational, not error style) — or a distinct
  warning style if easy.
- The warped image column is always shown when data is present; hidden initially.

---

## File Map

| Action | File | Change |
|--------|------|--------|
| Modify | `killer_sudoku/image/inp_image.py` | Store `warped_img`; make constructor non-raising for validation errors; add `spec`/`spec_error` attributes |
| Modify | `killer_sudoku/api/schemas.py` | Add `warning`, `warped_image_b64` to `UploadResponse` |
| Modify | `killer_sudoku/api/routers/puzzle.py` | Add `_build_diagnostic_spec`; use `spec_error`; include warped image in response |
| Modify | `killer_sudoku/static/index.html` | Add warped-img column to `#images-row` |
| Modify | `killer_sudoku/static/main.ts` | Handle new response fields; show warped image and warning |

---

## Error Handling

- `AssertionError` from `locate_grid` → still raises HTTP 422 (no useful data).
- All other pipeline errors → `spec_error` set; API returns 200 with warning.
- If `inp.spec_error` is set but `_build_diagnostic_spec` itself raises (e.g.
  `border_x`/`border_y` are degenerate) → fall back to HTTP 422 rather than
  crashing silently.

---

## Testing

- Add a unit test for `_build_diagnostic_spec`: given border arrays producing one
  oversized cage and a raw cage_totals array, verify the returned `PuzzleSpec`
  contains the right number of regions and the totals pass through unchanged.
- Existing tests are not changed (the `InpImage` contract for the success path is
  unchanged).

---

## Out of Scope

- Automatic correction of detected borders/totals.
- Warning persistence in the session state.
- Warped-image display when loading a saved session (no load path exists).
