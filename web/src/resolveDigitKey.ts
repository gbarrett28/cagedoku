export type DigitAction = 'placeDigit' | 'cycleCandidate';

/**
 * Maps mode + Ctrl state + key to a digit action.
 * Returns null when the key is not a handled digit or clear key.
 *
 * Ctrl inverts the mode for that keypress:
 *   candidateEditMode === ctrlKey  →  placeDigit
 *   candidateEditMode !== ctrlKey  →  cycleCandidate
 */
export function resolveDigitKey(
  candidateEditMode: boolean,
  ctrlKey: boolean,
  key: string,
): { action: DigitAction; digit: number } | null {
  let digit: number;
  if (key >= '1' && key <= '9') digit = Number(key);
  else if (key === 'Backspace' || key === 'Delete') digit = 0;
  else return null;

  const action: DigitAction = (candidateEditMode === ctrlKey) ? 'placeDigit' : 'cycleCandidate';
  return { action, digit };
}
