/** Shows the minimised-hint pill with the given hint title. */
export function showHintPill(pill: HTMLElement, labelEl: HTMLElement, title: string): void {
  labelEl.textContent = title;
  pill.hidden = false;
}

/** Hides the minimised-hint pill. */
export function hideHintPill(pill: HTMLElement): void {
  pill.hidden = true;
}
