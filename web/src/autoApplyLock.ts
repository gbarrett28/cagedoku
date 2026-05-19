/**
 * Locks or unlocks the set of user-action buttons during a slow-mo auto-apply
 * sequence. Extracted as a pure function (elements passed in) so it is
 * unit-testable without a full DOM bootstrap.
 */
export function applyAutoApplyLock(
  lockableButtons: HTMLButtonElement[],
  ffButton: HTMLButtonElement,
  locked: boolean,
): void {
  for (const btn of lockableButtons) {
    btn.disabled = locked;
  }
  ffButton.hidden = !locked;
}
