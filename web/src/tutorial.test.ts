// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initTutorial, appendCallouts, isTutorialActive, calcCalloutPosition, _resetForTest } from './tutorial.js';

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

describe('advanceCallout — iterative', () => {
  beforeEach(() => {
    // module-level beforeEach has already created callout/callout-text/callout-got-it
    const realBtn = document.createElement('button');
    realBtn.id = 'real-btn';
    realBtn.textContent = 'Real';
    document.body.appendChild(realBtn);
    _resetForTest();
  });

  it('skips all-missing elements without throwing', () => {
    expect(() =>
      appendCallouts([
        { id: 'missing-1', text: 'A' },
        { id: 'missing-2', text: 'B' },
        { id: 'missing-3', text: 'C' },
      ])
    ).not.toThrow();
  });

  it('leaves callout hidden when every queued element is missing', () => {
    appendCallouts([{ id: 'missing-1', text: 'A' }]);
    expect((document.getElementById('callout') as HTMLElement).hidden).toBe(true);
  });

  it('shows the first element that exists in the DOM', () => {
    appendCallouts([
      { id: 'missing-1', text: 'Skipped' },
      { id: 'real-btn',  text: 'Use this button' },
    ]);
    expect((document.getElementById('callout') as HTMLElement).hidden).toBe(false);
    expect(document.getElementById('callout-text')!.textContent).toBe('Use this button');
  });

  it('clicking Got it hides the callout and advances the queue', () => {
    appendCallouts([{ id: 'real-btn', text: 'First' }]);
    expect((document.getElementById('callout') as HTMLElement).hidden).toBe(false);
    (document.getElementById('callout-got-it') as HTMLButtonElement).click();
    expect((document.getElementById('callout') as HTMLElement).hidden).toBe(true);
  });
});

describe('calcCalloutPosition', () => {
  const CW = 260; // callout width
  const CH = 80;  // callout height

  it('centres callout on the button when viewport is wide', () => {
    // buttonCenterX=230, preferredLeft=100, clamped=100
    const r = calcCalloutPosition(CW, CH, { left: 200, top: 400, right: 260, bottom: 440, width: 60 }, 800, 600);
    expect(r.left).toBe(100);
  });

  it('clamps callout to left edge (min 8px)', () => {
    const r = calcCalloutPosition(CW, CH, { left: 4, top: 400, right: 44, bottom: 440, width: 40 }, 800, 600);
    expect(r.left).toBe(8);
  });

  it('clamps callout to right edge (max vpWidth - calloutWidth - 8)', () => {
    const r = calcCalloutPosition(CW, CH, { left: 760, top: 400, right: 800, bottom: 440, width: 40 }, 800, 600);
    expect(r.left).toBe(532); // 800 - 260 - 8
  });

  it('arrow offset equals distance from clamped left to button centre', () => {
    // left=100, buttonCenterX=230 → offset=130
    const r = calcCalloutPosition(CW, CH, { left: 200, top: 400, right: 260, bottom: 440, width: 60 }, 800, 600);
    expect(r.arrowOffset).toBe(130);
  });

  it('arrow offset is clamped to minimum 16px', () => {
    // button at far left: clampedLeft=8, buttonCenterX=24 → raw offset=16=ARROW_MIN
    const r = calcCalloutPosition(CW, CH, { left: 4, top: 400, right: 44, bottom: 440, width: 40 }, 800, 600);
    expect(r.arrowOffset).toBeGreaterThanOrEqual(16);
  });

  it('arrow offset is clamped to max (calloutWidth - 16)', () => {
    const r = calcCalloutPosition(CW, CH, { left: 760, top: 400, right: 800, bottom: 440, width: 40 }, 800, 600);
    expect(r.arrowOffset).toBeLessThanOrEqual(CW - 16);
  });

  it('places callout above when there is enough space above', () => {
    // spaceAbove=400 >= CH+GAP=92 → above
    const r = calcCalloutPosition(CW, CH, { left: 200, top: 400, right: 260, bottom: 440, width: 60 }, 800, 600);
    expect(r.direction).toBe('above');
    expect(r.top).toBeLessThan(400);
  });

  it('places callout below when insufficient space above but space below', () => {
    // target near top; spaceAbove=20 < 92; spaceBelow=540 >= 92
    const r = calcCalloutPosition(CW, CH, { left: 200, top: 20, right: 260, bottom: 60, width: 60 }, 800, 600);
    expect(r.direction).toBe('below');
    expect(r.top).toBeGreaterThan(60);
  });

  it('returns direction "none" when neither above nor below fits', () => {
    // 400px-tall callout in 450px viewport: neither 200px above nor 210px below >= 412
    const r = calcCalloutPosition(CW, 400, { left: 200, top: 200, right: 260, bottom: 240, width: 60 }, 800, 450);
    expect(r.direction).toBe('none');
  });
});
