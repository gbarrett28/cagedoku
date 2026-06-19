# Design: Training-consent toggle in the config modal

## Motivation

`training_consent` is currently a write-only cookie: `grantConsent()` is the
only way to set it, called exclusively from the "Always send" button inside
`showTrainingConsentModal`, which itself only appears as a side effect of a
stall report or a training-data export. There is no `revokeConsent()`, and
no UI surfaces the current consent state outside that one modal.

This creates a dead end for the `devSurfaceTelemetryFailures` dev diagnostic
(see `docs/architecture.md` "Telemetry-failure surfacing"): when consent is
absent, every distinct rule-bug/trigger-miss force-opens the feedback modal
to report the drop, but nothing in that modal — or anywhere else — lets the
user grant consent to stop it. The only way out is to happen to trigger the
unrelated stall/export consent flow, which may never occur in a session.

Training consent is also a privacy-relevant setting in its own right (any
user should be able to see and revoke it, not just developers debugging the
telemetry pipeline), so the fix is a general control, not a dev-gated one.

## Architecture

No new subsystem — this adds one function and wires up one existing modal.

### `web/src/image/trainingUpload.ts`

Add `revokeConsent()` next to the existing `grantConsent()`:

```ts
export function revokeConsent(): void {
  document.cookie = `${CONSENT_COOKIE}=; max-age=0`;
}
```

`hasConsent()` is unchanged — it already returns `false` for an absent
cookie, which is what an expired cookie becomes.

### `web/index.html`

Add a new row to `#config-modal`. The existing rows (`candidates-default-toggle`,
`essential-toggle`, `telemetry-failures-toggle`, delay slider) sit flatly
under the "Solver Rules" `<h2>`, which doesn't semantically fit a privacy
control. Add a small sub-heading to group it:

```html
<h3>Privacy</h3>
<div class="form-row">
  <label class="field-label" for="consent-toggle">Send anonymised training & bug-fixing data</label>
  <input type="checkbox" id="consent-toggle">
</div>
```

Placed directly above the existing rows (before "Show candidates by
default"), since it's the most general/least solver-specific setting in
the modal.

### `web/src/main.ts`

- `openConfigModal()`: add `el<HTMLInputElement>('consent-toggle').checked = hasConsent();` — reads the live cookie each time the modal opens, not `CoachSettings`, since consent is not a saved setting.
- At startup wiring (alongside the other one-time `addEventListener` calls), register a `change` listener on `consent-toggle`:
  ```ts
  el<HTMLInputElement>('consent-toggle').addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).checked) grantConsent();
    else revokeConsent();
  });
  ```
  Takes effect immediately on toggle, independent of the modal's Save/Cancel
  buttons — consistent with how `grantConsent()` already behaves when
  clicked from the training-consent modal. Cancelling the config modal does
  not undo a consent change made while it was open.

## Data flow

```
user opens config modal
  → consent-toggle.checked reflects hasConsent() (cookie read)
user toggles checkbox
  → change listener fires immediately
  → checked  → grantConsent()  → cookie set, max-age=1yr
  → unchecked → revokeConsent() → cookie cleared
  (no dependency on Save/Cancel)

next rule-bug/trigger-miss drop attempt
  → submitRuleBugReport / submitTriggerMissReport
  → hasConsent() now true
  → upload proceeds instead of being dropped
  → surfaceTelemetryFailure never fires for this cause again this session
```

## Error handling

None needed beyond what exists — `document.cookie` writes do not throw, and
`hasConsent()`/`grantConsent()` already have no error paths to extend.

## Testing

- **Unit** (`web/src/image/trainingUpload.test.ts`): `revokeConsent()` clears the cookie such that a subsequent `hasConsent()` call returns `false` (mirrors the existing `grantConsent` test pattern, which calls `grantConsent()` then asserts `hasConsent()` is `true`).
- **E2E** (`web/e2e/flow.spec.ts`): a new test alongside the existing "consent modal Always send sets training_consent=granted cookie" test — open the config modal, check `consent-toggle`, assert `document.cookie` contains `training_consent=granted`; uncheck it, assert the cookie is gone.

## Out of scope

- No "denied" tri-state — absence of the cookie already means "not granted" everywhere in the codebase; revoking just returns to that state.
- No confirmation dialog on revoke — this is a low-stakes, reversible toggle.
- No change to `CoachSettings`/`saveSettingsData` — consent is intentionally kept out of the saved-settings model, per the "Immediate" apply-timing decision.
