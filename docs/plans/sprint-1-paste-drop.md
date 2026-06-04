# Plan: Seamless Input — Sprint 1 (Paste & Drag-drop)

Implements clipboard paste, drag-and-drop, auto-process-on-select, and
File System Access API handle persistence on the Upload screen.
No PWA or manifest changes. Independently testable.

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

- [ ] **File System Access API: handle persistence + `startIn` hint**
  (`web/src/main.ts`, Chrome/Edge only — feature-detected, silent fallback)
  - After any successful `handleProcess(file)` call, attempt to store the
    `FileSystemFileHandle` in IndexedDB (`coach-fsa`, key `lastHandle`) using
    `window.showOpenFilePicker` availability as the feature guard. Only store when
    the file originated from `showOpenFilePicker` (not paste/drop — those have no
    handle). In practice: replace the hidden `#file-input` click path with
    `showOpenFilePicker({ startIn: lastHandle ?? 'pictures', multiple: false })`
    when the API is available; fall back to the `<input type="file">` click otherwise.
  - On DOMContentLoaded, read `lastHandle` from IndexedDB. If present and
    `await lastHandle.queryPermission({ mode: 'read' }) === 'granted'`, show a
    `#use-last-btn` button labelled "Use [filename]" above `#choose-btn`.
  - `#use-last-btn` click: `await lastHandle.requestPermission({ mode: 'read' })`,
    then `await lastHandle.getFile()`, call `void handleProcess(file)`. Hide the
    button if permission is denied.
  - Clear `lastHandle` from IndexedDB (and hide `#use-last-btn`) when the user
    clicks "New puzzle" so a stale suggestion doesn't persist across sessions.
  - Add `#use-last-btn` to `index.html` inside `#upload-panel`, `hidden` by default.

- [ ] **Tutorial callout update** (`web/src/main.ts`)
  - Replace `process-btn` callout ID with `choose-btn` in `buildUploadCallouts()`

- [ ] **Update `docs/ui.md`**
  - Upload Screen component table: replace "Process button" with "Choose image button"
    (`#choose-btn`); add paste, drop-zone, and "Use last image" entries
  - Button inventory: replace `#process-btn` row with `#choose-btn`; add `#use-last-btn`

## Tests

- [ ] **Unit test: paste handler** (`web/src/main.test.ts` or new file)
  - Synthesise a `ClipboardEvent` with an `image/png` item and verify `handleProcess`
    is called with the correct `File`
  - Verify paste is ignored when upload panel is hidden

- [ ] **Unit test: `#use-last-btn` visibility**
  - Mock IndexedDB with a stored handle whose `queryPermission` returns `'granted'`
  - Verify `#use-last-btn` is shown with the correct filename label
  - Verify it is hidden when permission returns `'denied'`
  - Verify it is hidden when no handle is stored

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
