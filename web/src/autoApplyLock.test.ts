// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { applyAutoApplyLock } from './autoApplyLock.js';

describe('applyAutoApplyLock', () => {
  let buttons: HTMLButtonElement[];
  let ffButton: HTMLButtonElement;

  beforeEach(() => {
    buttons = Array.from({ length: 3 }, () => document.createElement('button'));
    ffButton = document.createElement('button');
    ffButton.hidden = true;
  });

  it('disables every lockable button and shows FF button when locked', () => {
    applyAutoApplyLock(buttons, ffButton, true);
    expect(buttons.every(b => b.disabled)).toBe(true);
    expect(ffButton.hidden).toBe(false);
  });

  it('re-enables every lockable button and hides FF button when unlocked', () => {
    applyAutoApplyLock(buttons, ffButton, true);
    applyAutoApplyLock(buttons, ffButton, false);
    expect(buttons.every(b => b.disabled)).toBe(false);
    expect(ffButton.hidden).toBe(true);
  });

  it('does not affect FF button disabled state when locking', () => {
    applyAutoApplyLock(buttons, ffButton, true);
    expect(ffButton.disabled).toBe(false);
  });
});
