/**
 * Coach settings persistence via localStorage.
 *
 * Mirrors Python's api/settings.py SettingsStore, but without a file system —
 * settings are stored in the browser's localStorage under a fixed key.
 */

import type { CoachSettings } from './types.js';
import { DEFAULT_ALWAYS_APPLY_RULES } from './engine.js';

const SETTINGS_KEY = 'killer_sudoku_settings';

/** Returns the current settings, falling back to defaults if none are stored. */
export function loadSettings(): CoachSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return defaultSettings();
    const parsed: unknown = JSON.parse(raw);
    if (!isCoachSettings(parsed)) return defaultSettings();
    return parsed;
  } catch {
    return defaultSettings();
  }
}

/** Persists settings to localStorage. */
export function saveSettings(settings: CoachSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function defaultSettings(): CoachSettings {
  return { alwaysApplyRules: [...DEFAULT_ALWAYS_APPLY_RULES] };
}

function isCoachSettings(v: unknown): v is CoachSettings {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    Array.isArray(obj['alwaysApplyRules']) &&
    (obj['alwaysApplyRules'] as unknown[]).every(r => typeof r === 'string')
  );
}
