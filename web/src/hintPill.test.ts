// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { showHintPill, hideHintPill } from './hintPill.js';

describe('hintPill', () => {
  let pill: HTMLElement;
  let label: HTMLElement;

  beforeEach(() => {
    pill = document.createElement('div');
    pill.hidden = true;
    label = document.createElement('span');
    pill.appendChild(label);
  });

  describe('showHintPill', () => {
    it('makes the pill visible', () => {
      showHintPill(pill, label, 'Naked Single');
      expect(pill.hidden).toBe(false);
    });

    it('sets the label text to the hint title', () => {
      showHintPill(pill, label, 'Naked Single');
      expect(label.textContent).toBe('Naked Single');
    });

    it('updates the label when called again with a different title', () => {
      showHintPill(pill, label, 'First hint');
      showHintPill(pill, label, 'Second hint');
      expect(label.textContent).toBe('Second hint');
    });
  });

  describe('hideHintPill', () => {
    it('hides the pill', () => {
      showHintPill(pill, label, 'Naked Single');
      hideHintPill(pill);
      expect(pill.hidden).toBe(true);
    });
  });
});
