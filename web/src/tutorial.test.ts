// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initTutorial, appendCallouts, isTutorialActive } from './tutorial.js';

const STORAGE_KEY = 'coach_tutorial_suppressed';

function makeEl(tag: string, id: string, parent: HTMLElement = document.body): HTMLElement {
  const el = document.createElement(tag);
  el.id = id;
  parent.appendChild(el);
  return el;
}

// jsdom does not implement showModal/close on HTMLDialogElement — stub them.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function() {};
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function() {
    this.dispatchEvent(new Event('close'));
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.textContent = '';

  const modal = makeEl('dialog', 'general-help-modal') as HTMLDialogElement;
  makeEl('button', 'general-help-close-btn', modal);

  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'tutorial-suppress-cb';
  label.appendChild(cb);
  document.body.appendChild(label);

  const callout = makeEl('div', 'callout');
  (callout as HTMLElement).hidden = true;
  makeEl('p', 'callout-text', callout);
  const gotIt = makeEl('button', 'callout-got-it', callout);
  gotIt.textContent = 'Got it';
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('initTutorial', () => {
  it('skips everything when tutorial is suppressed in localStorage', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    initTutorial();
    expect(showModal).not.toHaveBeenCalled();
    expect(isTutorialActive()).toBe(false);
  });

  it('shows the help modal when tutorial is not suppressed', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    initTutorial();
    expect(showModal).toHaveBeenCalledOnce();
  });

  it('marks tutorial as active when not suppressed', () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
    initTutorial();
    expect(isTutorialActive()).toBe(true);
  });

  it('sets localStorage suppression key when checkbox is ticked and modal closes', () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
    initTutorial();
    (document.getElementById('tutorial-suppress-cb') as HTMLInputElement).checked = true;
    (document.getElementById('general-help-close-btn') as HTMLButtonElement).click();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('does NOT set suppression key when checkbox is not ticked', () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
    initTutorial();
    (document.getElementById('general-help-close-btn') as HTMLButtonElement).click();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('starts callouts even when "Don\'t show again" is ticked (suppresses future sessions only)', () => {
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
    initTutorial();
    appendCallouts([{ id: 'callout-got-it', text: 'test callout' }]);
    (document.getElementById('tutorial-suppress-cb') as HTMLInputElement).checked = true;
    (document.getElementById('general-help-close-btn') as HTMLButtonElement).click();
    // Callout should be visible — suppression only affects next session
    expect((document.getElementById('callout') as HTMLElement).hidden).toBe(false);
  });
});

describe('appendCallouts', () => {
  it('does nothing when tutorial is not active', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    initTutorial();
    appendCallouts([{ id: 'callout-got-it', text: 'tap here' }]);
    expect((document.getElementById('callout') as HTMLElement).hidden).toBe(true);
  });
});
