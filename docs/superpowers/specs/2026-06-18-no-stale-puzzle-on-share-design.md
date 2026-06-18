# No Stale Puzzle During Image Processing — Design

## Problem

When a new puzzle image is shared into the app (or uploaded via file-picker,
paste, or drag-drop) while a previous puzzle is already on screen, the old
puzzle remains visible — looking idle and complete — for the entire
OCR/grid-detection duration (`uploadPuzzle()`, several seconds). `setLoading(true)`
only disables the "Choose" button; it does not touch panel visibility or the
canvas. The user sees no indication that a new image is being processed until
it finishes.

A related gap: the app's pending-service-worker-update logic (`waitingSW`)
is currently applied in exactly one place — the `new-puzzle-btn` click
handler. A user who only ever shares images into the app (never clicking
that button) would never get a pending update applied, even though every
share-to-app action is already a full page navigation (the service worker
responds to the share POST with `Response.redirect(appRoot, 303)`).

## Goals

1. While a new image is processing, the screen must not show the previous
   puzzle. It should look like the empty upload panel, with a status message
   indicating processing is in progress.
2. If processing fails, the user lands on the empty upload panel with an
   error message — the previous puzzle is not restored (already accepted
   trade-off; the puzzle was cleared before processing started).
3. Share-only users must eventually receive pending app updates, not just
   users who click "New Puzzle".

## Non-goals

- Auto-applying a service-worker update **while the app is already open and
  a puzzle is on screen** (the `updatefound`/`installed` mid-session case).
  Auto-reloading then risks discarding in-progress solving work or
  interrupting an active hint/edit. This remains a follow-up; today's
  behaviour (apply on next "New Puzzle" click or next full reload) is
  unchanged for that case.
- Restoring the previous puzzle on processing failure.

## Design

### 1. Extract `resetToUploadPanel()`

The `new-puzzle-btn` click handler (`main.ts:2102-2150`) already contains a
correct, complete reset: it clears all puzzle-related module state, clears
the persisted session, resets every panel/button to its pre-upload
visibility, and applies any pending service-worker update
(`waitingSW`/`SKIP_WAITING`/reload-on-`controllerchange`).

Extract the body of that handler into a standalone `resetToUploadPanel()`
function, unchanged in behaviour. The click handler becomes:

```ts
el<HTMLButtonElement>('new-puzzle-btn').addEventListener('click', () => {
  logAction('new_puzzle');
  resetToUploadPanel();
});
```

### 2. Call it from `handleProcess()`

`handleProcess(file?: File)` (`main.ts:1128-1308`) calls `resetToUploadPanel()`
as its first action, before `await uploadPuzzle(f)`. Immediately after, set
a processing status message (e.g. `setStatus('Processing image…')`) so the
empty upload panel doesn't look inert.

This is the single fix point for all three upload entry points (share,
file-picker, paste/drag-drop), since they all converge on `handleProcess()`.

On success, the existing `applyUploadResult(...)` path already shows
`review-panel` and the new puzzle as today. On failure, the `catch` block's
existing `setStatus(..., true)` now displays its error over the empty
upload panel (since the reset already happened) instead of over the old
puzzle.

### 3. Boot-time pending-update check

Capture the service worker registration promise in a module-level variable
instead of only handling it via `.then()`:

```ts
const swRegistration: Promise<ServiceWorkerRegistration> | null =
  ('serviceWorker' in navigator && !import.meta.env.DEV)
    ? navigator.serviceWorker.register('./sw.js').catch(err => {
        console.warn('[SW] Registration failed:', err);
        return null;
      })
    : null;
```

(`updatefound`/`statechange` listener wiring for the mid-session case is
unchanged — still feeds `waitingSW` for the New Puzzle path.)

At the very start of the `DOMContentLoaded` handler, before `loadSession()`
and before `checkShareInbox()` run, await this registration and check
`registration.waiting`:

```ts
const registration = swRegistration ? await swRegistration : null;
if (registration?.waiting) {
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => location.reload(),
    { once: true },
  );
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  return; // reload is imminent; skip session restore / share-inbox drain this pass
}
```

This guarantees that every fresh page load — including every share, since a
share is always a full navigation via the service worker's 303 redirect —
applies any update that was already waiting before rendering anything,
without risking the in-flight shared file (it stays untouched in IndexedDB
until `checkShareInbox()` explicitly consumes it, which this check runs
before).

## Testing

- New Playwright pipeline test in `e2e/app.spec.ts` (gated by
  `PLAYWRIGHT_PIPELINE_TESTS=1`, following the existing pattern): upload a
  puzzle image, wait for `#review-panel` to become visible, then upload a
  second image via the same input and assert that `#review-panel` becomes
  hidden / `#upload-panel` becomes visible again before the second puzzle's
  `#review-panel` reappears — i.e. the reset is observably applied between
  the two uploads, not just on success of the second.
- Existing unit/e2e coverage for `new-puzzle-btn` behaviour must continue to
  pass unchanged after the extraction (no behaviour change for that path).
- The boot-time SW-update check is not practical to cover in Playwright
  (would require staging two different SW versions); it is small,
  isolated, and the existing `__setWaitingSW` test hook pattern shows the
  precedent for this kind of logic being unit-tested at a smaller grain if
  needed. No new automated test is added for this piece; manual smoke
  verification is sufficient given its small size and direct mirroring of
  already-tested logic (the New Puzzle button's skip-wait/reload sequence).

## Risks

- Moving the registration-await to block the start of `DOMContentLoaded`
  adds a small amount of latency to every boot (one microtask/promise
  resolution in the common case where the registration is already settled
  by the time `DOMContentLoaded` fires, since SW registration started at
  module-eval time which runs before `DOMContentLoaded`). No risk of
  hanging indefinitely: `register()` always settles (resolve or the
  caught/`null` fallback above).
