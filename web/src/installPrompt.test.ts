// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { INSTALL_DISMISSED_KEY, shouldShowInstallBanner } from './installPrompt.js';

describe('shouldShowInstallBanner', () => {
  beforeEach(() => { localStorage.clear(); });

  it('returns true when the dismissed key is absent', () => {
    expect(shouldShowInstallBanner(localStorage)).toBe(true);
  });

  it('returns false when the dismissed key is present', () => {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    expect(shouldShowInstallBanner(localStorage)).toBe(false);
  });

  it('accepts an injected storage object for isolation', () => {
    expect(shouldShowInstallBanner({ getItem: () => null })).toBe(true);
    expect(shouldShowInstallBanner({ getItem: () => '1'  })).toBe(false);
  });
});
