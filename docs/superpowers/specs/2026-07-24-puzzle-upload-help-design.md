# Design: Puzzle Upload Help (site links + import tips)

## Context

Issue #163 asked for two things on the upload screen: links to popular sudoku
sites (with a hint on relative difficulty), and tips on the best way to get a
puzzle photo/file into the app. Investigation while scoping this surfaced that
a plain camera photo is untested and the one attempt that was made didn't
work, so the import tips should center on the app's already-working non-photo
input paths instead of encouraging photography:

- `document.addEventListener('paste', ...)` in `main.ts` — clipboard paste
  of an image while the upload panel is visible.
- `imageInput.ts`'s `imageFileFromDrop` — drag-and-drop.
- PDF upload — `file-input` already accepts `application/pdf`, and both
  `inpImage.ts` and `session/actions.ts` render page 1 via `pdfjs-dist`
  before OCR. A downloaded/printed-to-PDF puzzle page works directly, with
  no photography artefacts at all.
- Web Share Target (`manifest.webmanifest`'s `share_target`, handled in
  `sw.js`, documented in `docs/ui.md` "Web Share Target") — Android only,
  and only once the PWA is installed.
- File Handling API (`manifest.webmanifest`'s `file_handlers` +
  `launchQueue` consumer in `main.ts`) — installed PWA on any platform that
  supports it.
- The existing `beforeinstallprompt` / `deferredInstallPrompt` /
  `install-btn` / `showInstallBanner()` plumbing in `main.ts`, which this
  feature reuses rather than duplicating.

## Goal

Add a single collapsed-by-default disclosure directly below the existing
upload actions (Choose image…, Use last image, the drag/paste drop zone) so
familiar users see zero change, while new or stuck users have one place to
find "where do I get a puzzle" and "how do I get it into the app."

## Non-goals

- No camera-photo guidance (untested, one real attempt failed — out of
  scope until it's actually verified to work).
- No new persisted state (disclosure open/closed is not remembered across
  visits; always starts collapsed).
- No dynamic/remote-configured site list — the four entries are static
  markup, not data-driven.
- No new install-prompt mechanism — this reuses `deferredInstallPrompt`
  exactly as `install-btn` already does; it does not add a second way to
  trigger installation.

## UI placement & content

A `<details>`-style disclosure, closed by default, inserted immediately
after the existing upload actions in `#upload-panel`. Summary text: "Need a
puzzle, or having trouble uploading?"

**Site list** (static, four entries, each a link + one-line note):

| Site | Note |
|---|---|
| The Guardian (link) / The Observer (link) — two separate links in one row | Best match — this app's puzzle reader was trained on these |
| sudoku.com | Killer + classic, adjustable difficulty |
| killersudokuonline.com | Killer only, 4 difficulty levels |
| websudoku.com | Classic only, large archive |

**Import tips.** Baseline lines, always shown:

1. Download the puzzle image or PDF, then use "Choose image…" (PDFs are
   read directly — no photography needed).
2. Copy an image (e.g. right-click → Copy image) and paste it with
   Ctrl+V / Cmd+V anywhere on this screen.
3. Drag and drop an image file onto this screen.

Exactly one additional line on top, chosen by detected environment (see
below):

- **`not-installed`**: "Install the app for one-tap sharing straight from
  Photos." If `deferredInstallPrompt` has fired, this is a real button that
  calls `deferredInstallPrompt.prompt()` (same call `install-btn` already
  makes). If it hasn't fired (iOS Safari, Firefox, or any browser that
  never dispatches `beforeinstallprompt`), it's plain text: "Add to Home
  Screen from your browser's Share menu."
- **`installed-android`**: "Share the image to COACH directly from Photos
  or any app's Share menu" — describes the real Web Share Target path.
- **`installed-other`** (installed, non-Android — iOS or desktop): no
  extra line. Baseline tips only.

## Detection

A new pure function, `detectUploadEnvironment()`, added to
`web/src/imageInput.ts` alongside the existing clipboard/drag helpers:

```ts
export type UploadEnvironment = 'not-installed' | 'installed-android' | 'installed-other';

export function detectUploadEnvironment(win: Window, nav: Navigator): UploadEnvironment {
  const installed =
    win.matchMedia('(display-mode: standalone)').matches ||
    (nav as Navigator & { standalone?: boolean }).standalone === true;
  if (!installed) return 'not-installed';
  return /Android/.test(nav.userAgent) ? 'installed-android' : 'installed-other';
}
```

Taking `win`/`nav` as parameters (rather than reading `window`/`navigator`
globally) keeps it a pure, directly-testable function, matching the style
of `imageFileFromClipboard`/`imageFileFromDrop` in the same file.

`main.ts` calls this once during setup, then shows/hides the three
candidate tip-line elements by id the same way it already toggles
`bigapple-banner` — no new state machine, no re-evaluation on resize/visibility
change (display-mode doesn't change during a session in practice).

The "not-installed" button/text branch reuses the existing
`deferredInstallPrompt` variable and click handling already in `main.ts`
for `install-btn`; it does not introduce a second `beforeinstallprompt`
listener.

## Data flow

Stateless. `detectUploadEnvironment()` runs once at startup from
`matchMedia`/`navigator.userAgent`/`navigator.standalone` — no
`localStorage`, no session persistence, no network calls. The disclosure's
open/closed state lives purely in the `<details>` element's own `open`
attribute for the lifetime of the page load.

## Error handling

None needed beyond what already exists: if detection is wrong (e.g. a
future non-Android browser somehow supports Share Target), the worst case
is a mis-worded tip line, never a broken upload — the choose/paste/drag-drop
code paths this panel describes are untouched by this feature. If
`deferredInstallPrompt` never fires, the button branch is simply never
shown; the plain-text fallback is always correct because it's just generic
"Add to Home Screen" guidance.

## Testing

- **Unit** (`web/src/imageInput.test.ts`): `detectUploadEnvironment()`
  against the four input combinations (installed × Android), mocking
  `matchMedia`/`userAgent`/`standalone`, following the existing
  `makeClipboardEvent`/`makeDragEvent` mock style in that file.
- **E2e** (`web/e2e/flow.spec.ts`): disclosure starts collapsed and does
  not shift the position of the existing upload buttons; expanding it
  reveals the site list and tips; one variant test stubs `matchMedia` via
  `page.addInitScript` to assert the `installed-android` tip line renders
  when appropriate. No new prod-code test hook needed.
