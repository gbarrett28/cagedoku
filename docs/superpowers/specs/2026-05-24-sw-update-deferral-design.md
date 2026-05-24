# Service Worker Update Deferral — Design Spec

**Goal:** Prevent GitHub Pages deployments from reloading the page mid-solve by deferring the service worker update until the user clicks "New Puzzle".

**Architecture:** Remove the unconditional `skipWaiting()` from the SW install handler. The new SW parks in the `waiting` state. `main.ts` detects the waiting SW and, when "New Puzzle" is clicked (state already cleared), posts a `SKIP_WAITING` message; the SW calls `skipWaiting()` and the page reloads via a `controllerchange` listener.

**Scope:** Two files — `web/public/sw.js` and `web/src/main.ts`. No new modules, no new UI.

---

## Changes

### `web/public/sw.js`

**Remove** `await self.skipWaiting()` from the `install` handler body. The handler still opens the cache and precaches assets; it just no longer fast-tracks the new SW into the active state.

**Add** a `message` event listener at module level:

```js
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
```

The `activate` handler (`clients.claim()`) is unchanged.

### `web/src/main.ts`

Replace the bare `navigator.serviceWorker.register(...)` call with a registration block that:

1. **Stores a waiting SW reference.** A `let waitingSW: ServiceWorker | null = null` variable is declared inside the `if ('serviceWorker' in navigator …)` block.

2. **Captures an already-waiting SW.** Immediately after `await`-ing (or `.then`-ing) the registration, if `registration.waiting` is non-null, assign it to `waitingSW`. This handles the case where the tab was opened after the new SW installed but before the user interacted.

3. **Watches for future installs.** `registration.addEventListener('updatefound', () => { … })` fires when a new SW begins installing. Inside, `registration.installing.addEventListener('statechange', () => { if (sw.state === 'installed') waitingSW = sw; })` captures the SW once it reaches `waiting`.

4. **Applies the update on New Puzzle.** At the end of the existing `new-puzzle-btn` click handler, after all state is cleared:
   ```ts
   if (waitingSW !== null) {
     navigator.serviceWorker.addEventListener(
       'controllerchange',
       () => location.reload(),
       { once: true },
     );
     waitingSW.postMessage({ type: 'SKIP_WAITING' });
     waitingSW = null;
   }
   ```
   The `{ once: true }` option auto-removes the listener after it fires once.

---

## Behaviour

| Scenario | Result |
|---|---|
| User is mid-solve when a deploy lands | New SW installs silently into `waiting`; user continues uninterrupted |
| User clicks New Puzzle | State cleared → SKIP_WAITING posted → SW activates → `controllerchange` fires → `location.reload()` → fresh code served |
| User never clicks New Puzzle in a session | Old SW stays active; old version continues working from its cache |
| Multiple deploys in one session | Each `updatefound` replaces `waitingSW`; only the latest waiting SW is applied |
| Tab opened after deploy (SW already waiting) | `registration.waiting` is non-null; captured immediately; applied on next New Puzzle |

---

## Testing

One new Vitest-compatible Playwright test in `web/e2e/flow.spec.ts`:

**`'new puzzle with pending SW update posts SKIP_WAITING message'`**

Setup: inject a mock waiting SW into `navigator.serviceWorker` via `page.evaluate` (or intercept the registration via a test helper) so that `registration.waiting` returns a stub whose `postMessage` sets `window.__swSkipWaitingCalled = true`. Load the trivial killer puzzle (via `window.__testLoad()`), reach playing mode, then click New Puzzle.

Assert: `window.__swSkipWaitingCalled === true`.

This test runs against `vite dev` (no OpenCV needed) and completes in a few seconds.

---

## Out of Scope

- Showing an "update available" badge or toast — not needed; the update is transparent to the user.
- Applying the update immediately when at the upload screen — deferred for now; the silent approach is sufficient.
- Changing how `CACHE_VERSION` is bumped — unchanged; the SW file always differs between builds because `PRECACHE_ASSETS` contains hashed filenames.
