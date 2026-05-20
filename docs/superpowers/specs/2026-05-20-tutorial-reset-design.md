# Tutorial Reset via K Badge Design

**Date:** 2026-05-20
**Issue:** #84
**Scope:** `web/src/main.ts`, `web/src/tutorial.ts` (read-only — no new exports needed)

---

## Context

Users who dismissed the tutorial with "Don't show again" have no way to restart it. The K badge (`#logo-k`) in the header is a natural affordance for this: it's always visible, it's the app identity mark, and clicking it to "reset to the beginning" is intuitive.

The tutorial should also explain what the K badge does, so a new callout step is added at the end of the playing-screen sequence.

---

## Design

### 1. K Badge Click Handler (`main.ts`)

Add a `click` listener to `#logo-k`. The handler:

1. **No-op guard**: if the callout box is currently visible (`!calloutEl.hidden`), do nothing — a reset mid-step would be disorienting.
2. **Clear suppression**: `localStorage.removeItem('coach_tutorial_suppressed')`.
3. **Re-initialise**: call `initTutorial()`, which resets all module state (`calloutQueue`, `calloutRunning`, `calloutStarted`, `tutorialActive`) and re-shows `#general-help-modal`. Since the localStorage key was just removed, the `initTutorial()` guard (`if localStorage === 'true' return`) is bypassed.
4. **Pre-fill the queue** for the current screen by calling `appendCallouts(...)` *before* the user dismisses the modal. Because `calloutStarted = false` at this point, `appendCallouts` pushes to the queue without triggering `advanceCallout`. When the user closes the modal, `calloutStarted` becomes `true` and `advanceCallout()` fires from the filled queue.

**Queue selection by screen:**

| Screen | Detection | Callouts queued |
|---|---|---|
| Upload | `currentState === null` and `#review-actions` hidden | `[{id: 'process-btn', text: '…'}]` |
| Review | `#review-actions` not hidden | `[{id: 'confirm-btn', text: '…'}]` |
| Playing | `#playing-actions` not hidden | full `playingCallouts` sequence (see §2) |

The playing callouts are built the same way as in `renderPlayingMode` — killer-only buttons (`inspect-cage-btn`, `virtual-cage-btn`) spliced in when `currentState.puzzleType !== 'classic'`.

To avoid duplicating the `playingCallouts` array, extract it into a `buildPlayingCallouts(isKiller: boolean): CalloutItem[]` helper in `main.ts` called by both `renderPlayingMode` and the reset handler.

### 2. New Callout Step — `logo-k`

Add `logo-k` as the **last** step of the playing-screen callout sequence (after `new-puzzle-btn`):

```
… → new-puzzle-btn → logo-k
```

**Text:** `"Tap the K badge at any time to restart this tutorial."`

This applies to both killer and classic sequences.

### 3. No New `tutorial.ts` Exports

The existing `initTutorial()` and `appendCallouts()` are sufficient. The no-op guard reads `document.getElementById('callout')!.hidden` directly — no new exports needed.

---

## Files Changed

| File | Change |
|---|---|
| `web/src/main.ts` | Extract `buildPlayingCallouts(isKiller)`; add `#logo-k` click handler; add `logo-k` callout step |

---

## Testing

- Playwright (`flow.spec.ts`): verify clicking `#logo-k` while the tutorial is suppressed re-shows `#general-help-modal`; after dismissing, the first callout for the current screen appears.
- Existing tutorial unit tests (`tutorial.test.ts`) unchanged — no `tutorial.ts` changes.
- Bronze gate: `tsc --noEmit` + `npm test` pass.
