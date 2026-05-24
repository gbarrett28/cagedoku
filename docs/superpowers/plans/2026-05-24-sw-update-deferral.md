# SW Update Deferral Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent GitHub Pages deployments from reloading the page mid-solve by deferring the service worker `skipWaiting()` call until the user clicks "New Puzzle".

**Architecture:** Remove `skipWaiting()` from the SW `install` handler so the new SW parks in `waiting`. `main.ts` stores the waiting worker reference, then posts `{ type: 'SKIP_WAITING' }` when New Puzzle is clicked (after state is already cleared); the SW responds with `self.skipWaiting()` and the page reloads via a one-shot `controllerchange` listener.

**Tech Stack:** Vanilla Service Worker API, TypeScript (main.ts), Playwright (flow test).

---

## Files

- **Modify:** `web/public/sw.js` — remove `skipWaiting()` from install, add message listener
- **Modify:** `web/src/main.ts` — module-level `waitingSW`, detection logic, New Puzzle trigger, dev test hook
- **Modify:** `web/e2e/flow.spec.ts` — add one new test

---

### Task 1: Update `sw.js` — park in waiting, respond to message

**Files:**
- Modify: `web/public/sw.js`

- [ ] **Step 1: Remove `skipWaiting()` from the install handler**

  Open `web/public/sw.js`. The install handler currently ends with:
  ```js
        // Skip the waiting phase — the new SW takes control immediately.
        await self.skipWaiting();
      }),
    );
  });
  ```
  Replace those two lines (the comment + the `await`) so the handler ends with just the closing braces:
  ```js
      }),
    );
  });
  ```

  The full install handler should now look like this:
  ```js
  self.addEventListener('install', (event) => {
    event.waitUntil(
      caches.open(CACHE_NAME).then(async (cache) => {
        // Cache assets one by one so a single failure doesn't abort the whole install.
        await Promise.allSettled(
          PRECACHE_ASSETS.map(url =>
            cache.add(url).catch(err =>
              console.warn(`[SW] Failed to precache ${url}:`, err),
            ),
          ),
        );
        // New SW parks in 'waiting' — skipWaiting() is called later via
        // a SKIP_WAITING message sent by the page on "New Puzzle" click.
      }),
    );
  });
  ```

- [ ] **Step 2: Add a `message` listener after the `activate` handler**

  After the closing `});` of the `activate` listener block, add:
  ```js
  // ---------------------------------------------------------------------------
  // Message — apply a deferred update when the page says it is safe to do so.
  // The page posts { type: 'SKIP_WAITING' } from the new-puzzle-btn handler,
  // after all puzzle state has been cleared.
  // ---------------------------------------------------------------------------

  self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  });
  ```

- [ ] **Step 3: Verify `sw.js` looks correct**

  The file should now have three event listeners in order: `install`, `activate`, `message`, then `fetch`. Confirm by reading the file. There should be no remaining call to `self.skipWaiting()` outside of the message handler.

- [ ] **Step 4: Commit**

  ```bash
  cd web
  git add public/sw.js
  git commit -m "fix: park new SW in waiting instead of skipping immediately (#119)

  Remove self.skipWaiting() from the install handler so a new service
  worker waits rather than immediately displacing the active one.
  Add a 'message' listener: when the page posts { type: 'SKIP_WAITING' }
  (triggered by the New Puzzle button), the SW calls skipWaiting() then.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

### Task 2: Update `main.ts` — detect waiting SW, trigger on New Puzzle

**Files:**
- Modify: `web/src/main.ts`

Background: `main.ts` has two relevant blocks near the bottom. The SW registration block (currently lines 1349–1355) is inside `if ('serviceWorker' in navigator && !import.meta.env.DEV)`. The `new-puzzle-btn` click handler is inside `document.addEventListener('DOMContentLoaded', …)`. Both need to share a `waitingSW` variable, so it must be declared at module level between them.

- [ ] **Step 1: Add the module-level `waitingSW` declaration**

  Find this comment in `main.ts` (currently around line 1349):
  ```ts
  // Register the offline service worker. Only runs in production builds — skipped
  // during Vite dev mode to prevent the SW from intercepting HMR/module requests.
  if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  ```

  Insert two lines immediately before that comment:
  ```ts
  // Waiting service worker: set when a new SW installs but has not yet taken control.
  // Sent SKIP_WAITING via postMessage when the user clicks New Puzzle (state cleared).
  let waitingSW: ServiceWorker | null = null;

  ```

- [ ] **Step 2: Replace the registration call with the full detection block**

  The current registration block is:
  ```ts
  if ('serviceWorker' in navigator && !import.meta.env.DEV) {
    void navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('[SW] Registration failed:', err);
    });
  }
  ```

  Replace it with:
  ```ts
  if ('serviceWorker' in navigator && !import.meta.env.DEV) {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => {
        // Capture a SW that is already waiting (e.g. tab opened after a deploy
        // landed but before the user interacted with the page).
        if (registration.waiting) waitingSW = registration.waiting;

        // Capture future updates: fires when a new SW begins installing.
        registration.addEventListener('updatefound', () => {
          const sw = registration.installing;
          if (sw === null) return;
          sw.addEventListener('statechange', () => {
            // 'installed' means the SW finished installing and is now waiting.
            if (sw.state === 'installed') waitingSW = sw;
          });
        });
      })
      .catch(err => {
        console.warn('[SW] Registration failed:', err);
      });
  }
  ```

- [ ] **Step 3: Add the dev-mode test hook**

  Immediately after the registration block, add:
  ```ts
  // Dev-only test hook: lets Playwright tests inject a fake waiting SW so the
  // SKIP_WAITING path can be exercised without a real service worker.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>)['__setWaitingSW'] =
      (sw: ServiceWorker | null) => { waitingSW = sw; };
  }
  ```

- [ ] **Step 4: Add the SKIP_WAITING trigger to the New Puzzle button handler**

  Find the end of the `new-puzzle-btn` click handler. It currently ends with:
  ```ts
    el<HTMLInputElement>('file-input').value = '';
    setStatus('');
  });
  ```

  Insert the update trigger before the closing `});`:
  ```ts
    el<HTMLInputElement>('file-input').value = '';
    setStatus('');

    // Apply any pending SW update now that all puzzle state has been cleared.
    // The page will reload once the new SW activates and fires controllerchange.
    if (waitingSW !== null) {
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => location.reload(),
        { once: true },
      );
      waitingSW.postMessage({ type: 'SKIP_WAITING' });
      waitingSW = null;
    }
  });
  ```

- [ ] **Step 5: Run the TypeScript compiler to confirm no type errors**

  ```bash
  cd web
  npx tsc --noEmit
  ```

  Expected: no output (zero errors).

- [ ] **Step 6: Commit**

  ```bash
  git add src/main.ts
  git commit -m "feat: defer SW update to New Puzzle click (#119)

  Detect waiting service workers via registration.waiting and
  updatefound/statechange listeners. Store the waiting worker in a
  module-level variable. When the user clicks New Puzzle (after all
  puzzle state is already cleared), post { type: 'SKIP_WAITING' } to
  the waiting worker. Reload the page via a one-shot controllerchange
  listener once the new SW takes control.

  Adds a dev-only __setWaitingSW() hook for Playwright testing.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

### Task 3: Playwright flow test

**Files:**
- Modify: `web/e2e/flow.spec.ts`

- [ ] **Step 1: Write the failing test**

  In `web/e2e/flow.spec.ts`, find the existing test:
  ```ts
  test('new puzzle button returns to upload panel', async ({ page }) => {
  ```

  Add the new test immediately after its closing `});`:
  ```ts
  test('new puzzle with pending SW update posts SKIP_WAITING to waiting worker', async ({ page }) => {
    await loadTrivialPuzzle(page);

    // Inject a fake waiting SW via the dev-only hook exposed by main.ts.
    await page.evaluate(() => {
      const messages: unknown[] = [];
      const fakeSW = {
        postMessage: (msg: unknown) => { messages.push(msg); },
      } as unknown as ServiceWorker;
      (window as unknown as Record<string, unknown>)['__swPostedMessages'] = messages;
      const hook = (window as unknown as Record<string, unknown>)['__setWaitingSW'] as
        ((sw: ServiceWorker) => void) | undefined;
      if (!hook) throw new Error('__setWaitingSW not found — dev hook missing');
      hook(fakeSW);
    });

    await page.locator('#new-puzzle-btn').click();
    await expect(page.locator('#upload-panel')).toBeVisible();

    const posted = await page.evaluate(
      () => (window as unknown as Record<string, unknown>)['__swPostedMessages'] as unknown[],
    );
    expect(posted).toContainEqual({ type: 'SKIP_WAITING' });
  });
  ```

- [ ] **Step 2: Run the new test to verify it fails before the implementation**

  The implementation (Task 2) should already be done at this point, so this step confirms it passes rather than fails. If you are doing strict TDD and want to add the test before Task 2, expect it to fail with `__setWaitingSW not found`.

  ```bash
  cd web
  npx playwright test --config playwright.dev.config.ts \
    --grep "SKIP_WAITING"
  ```

  Expected: **1 passed**.

- [ ] **Step 3: Run the full flow test suite**

  ```bash
  npx playwright test --config playwright.dev.config.ts
  ```

  Expected: all tests pass (currently 43 + the new one = 44 passed).

- [ ] **Step 4: Run the bronze gate**

  From the repo root:
  ```bash
  bash scripts/run-bronze-gate.sh
  ```

  Expected: `Bronze gate passed. Token created`.

- [ ] **Step 5: Commit**

  ```bash
  cd web
  git add e2e/flow.spec.ts
  git commit -m "test: verify SKIP_WAITING posted to waiting SW on New Puzzle (#119)

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

### Task 4: Silver gate + merge

- [ ] **Step 1: Update docs/ui.md** (silver gate doc hygiene)

  Find the service worker section in `docs/ui.md` (search for "service worker" or "offline"). Add a note explaining the deferred update behaviour:

  > **SW update deferral:** The service worker no longer calls `skipWaiting()` on install. Instead it parks in the `waiting` state until the user clicks "New Puzzle", at which point `main.ts` posts `{ type: 'SKIP_WAITING' }` to the waiting worker. The page then reloads via a `controllerchange` listener — after all puzzle state has already been cleared — so no in-progress solve is interrupted.

- [ ] **Step 2: Run the silver gate**

  ```bash
  cd /path/to/repo/root
  bash scripts/run-silver-gate.sh
  ```

  Expected: all checks pass, silver gate token created.

- [ ] **Step 3: Merge to master and push**

  ```bash
  git checkout master
  git merge feature/sw-update-deferral
  git push origin master
  git branch -d feature/sw-update-deferral
  ```

- [ ] **Step 4: Verify deployment**

  ```bash
  gh run list --limit 3
  ```

  Expected: a "Deploy to GitHub Pages" run for the merge commit shows `in_progress` then `completed success`.

- [ ] **Step 5: Delete the spec and plan files** (silver gate doc hygiene)

  ```bash
  rm docs/superpowers/specs/2026-05-24-sw-update-deferral-design.md
  rm docs/superpowers/plans/2026-05-24-sw-update-deferral.md
  bash scripts/run-bronze-gate.sh
  git add -A
  git commit -m "chore: delete implemented SW update deferral spec and plan"
  git push origin master
  ```
