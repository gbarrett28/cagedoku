/**
 * Persists the active puzzle session to localStorage so an accidental page
 * refresh does not lose progress.
 *
 * Only state that cannot be recomputed is stored.  Image data URLs are
 * intentionally dropped before saving — they can be 1-3 MB each, easily
 * exceeding the localStorage quota, and are purely decorative once the user
 * is in playing mode (both image columns are hidden).  All candidate data is
 * recomputed from the turn history on restore.
 *
 * Schema version: bump STORAGE_KEY when PuzzleState changes incompatibly.
 */

import type { PuzzleState } from './types.js';

const STORAGE_KEY = 'cagedoku:session:v1';

interface PersistedSession {
  readonly version: 1;
  /** PuzzleState with originalImageUrl and warpedImageUrl set to null. */
  readonly state: PuzzleState;
  readonly cellColours: Record<string, 'blue' | 'green'>;
}

export function saveSession(
  state: PuzzleState,
  cellColours: Map<string, 'blue' | 'green'>,
): void {
  const stripped = { ...state, originalImageUrl: null, warpedImageUrl: null } as PuzzleState;
  const payload: PersistedSession = {
    version: 1,
    state: stripped,
    cellColours: Object.fromEntries(cellColours) as Record<string, 'blue' | 'green'>,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage quota exceeded or unavailable — silently ignore
  }
}

export function loadSession(): {
  state: PuzzleState;
  cellColours: Map<string, 'blue' | 'green'>;
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const payload = JSON.parse(raw) as Partial<PersistedSession>;
    // Only restore a confirmed (playing-mode) session
    if (payload.version !== 1 || payload.state == null || payload.state.userGrid === null) return null;
    return {
      state: payload.state,
      cellColours: new Map(Object.entries(payload.cellColours ?? {})) as Map<string, 'blue' | 'green'>,
    };
  } catch {
    return null;
  }
}

export function clearPersistedSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
