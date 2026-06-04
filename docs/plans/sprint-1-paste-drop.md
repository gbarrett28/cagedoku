# Plan: Seamless Input — Sprint 1 (Paste & Drag-drop)

Implements clipboard paste, drag-and-drop, and auto-process-on-select on the
Upload screen. No PWA or manifest changes. Independently testable.

---

## Implementation

- [ ] **Refactor `handleProcess` signature** (`web/src/main.ts`)
  - Change signature to `async function handleProcess(file?: File): Promise<void>`
  - Replace `fileInput.files[0]` with `file ?? el<HTMLInputElement>('file-input').files?.[0]`
  - Update error message to "Please drop, paste, or select an image."

- [ ] **Auto-process on file-input change**
  - Add `change` event listener on `#file-input` that calls `void handleProcess()`
  - Replace the `#process-btn` click handler + button with a "Choose image…" button
    that calls `el<HTMLInputElement>('file-input').click()`
  - Hide `#file-input` with `style="display:none"` and wire the new button to it
  - Update `setLoading()` to disable/enable the new choose button instead of `process-btn`
  - Update `ui.md` button inventory: replace `#process-btn` with `#choose-btn`

- [ ] **Clipboard paste handler** (`web/src/main.ts`)
  - Add `document.addEventListener('paste', ...)` inside `DOMContentLoaded`
  - Guard: return early if `el<HTMLElement>('upload-panel').hidden`
  - Extract the first `image/*` item from `e.clipboardData?.items`
  - Call `void handleProcess(item.getAsFile()!)` if found
  - `e.preventDefault()` to suppress default browser paste behaviour

- [ ] **Drag-and-drop handler** (`web/src/main.ts`)
  - Wire `dragover`, `dragleave`, `drop` on `#upload-panel`
  - `dragover`: `e.preventDefault()`, add `drag-over` CSS class
  - `dragleave` / `dragend`: remove `drag-over` class
  - `drop`: `e.preventDefault()`, remove class, extract `e.dataTransfer?.files[0]`,
    guard `file.type.startsWith('image/')`, call `void handleProcess(file)`
  - Guard all handlers: return early if `upload-panel` is hidden

- [ ] **Upload panel hint text** (`web/index.html`)
  - Add `<p id="upload-hint" class="upload-hint">or drag &amp; drop / paste (⌘V&nbsp;/&nbsp;Ctrl+V)</p>`
    below `#choose-btn` inside `#upload-panel`

- [ ] **CSS for drop zone and hint** (`web/public/styles.css`)
  - `.upload-hint` — small, muted secondary text
  - `#upload-panel.drag-over` — subtle visual feedback (e.g. dashed border tint)

- [ ] **Tutorial callout update** (`web/src/main.ts`)
  - Replace `process-btn` callout ID with `choose-btn` in `buildUploadCallouts()`

- [ ] **Update `docs/ui.md`**
  - Upload Screen component table: replace "Process button" with "Choose image button"
    (`#choose-btn`); add paste and drop-zone entries
  - Button inventory: replace `#process-btn` row with `#choose-btn`

## Tests

- [ ] **Unit test: paste handler** (`web/src/main.test.ts` or new file)
  - Synthesise a `ClipboardEvent` with an `image/png` item and verify `handleProcess`
    is called with the correct `File`
  - Verify paste is ignored when upload panel is hidden

- [ ] **Unit test: drop handler**
  - Synthesise a `DragEvent` with a `DataTransfer` containing an image file
  - Verify `handleProcess` is called; verify non-image drop is ignored

- [ ] **E2E smoke test** (`web/e2e/app.spec.ts` or new file)
  - Confirm that selecting a file via `#file-input` (`page.setInputFiles`) triggers
    processing without a separate button click (the existing test likely clicks
    `#process-btn` — update it)

## Gate

- [ ] Run `bash scripts/run-bronze-gate.sh` — all checks pass
- [ ] Commit on `claude/seamless-puzzle-analysis-xljer`
