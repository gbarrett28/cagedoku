export interface CalloutItem {
  id: string;
  text: string;
}

export interface CalloutPosition {
  top: number;
  left: number;
  arrowOffset: number;
  direction: 'above' | 'below' | 'none';
}

const _GAP = 12;       // px gap between callout edge and target
const _EDGE = 8;       // min distance from viewport edge
const _ARROW_MIN = 16; // min/max arrow offset from callout edge (keeps arrow tip inside box)

export function calcCalloutPosition(
  calloutWidth: number,
  calloutHeight: number,
  targetRect: { left: number; top: number; right: number; bottom: number; width: number },
  vpWidth: number,
  vpHeight: number,
): CalloutPosition {
  const buttonCenterX = targetRect.left + targetRect.width / 2;
  const left = Math.max(_EDGE, Math.min(buttonCenterX - calloutWidth / 2, vpWidth - calloutWidth - _EDGE));
  const arrowOffset = Math.max(_ARROW_MIN, Math.min(buttonCenterX - left, calloutWidth - _ARROW_MIN));

  if (targetRect.top >= calloutHeight + _GAP) {
    return { top: targetRect.top - _GAP - calloutHeight, left, arrowOffset, direction: 'above' };
  }
  if (vpHeight - targetRect.bottom >= calloutHeight + _GAP) {
    return { top: targetRect.bottom + _GAP, left, arrowOffset, direction: 'below' };
  }
  return { top: Math.max(_EDGE, (vpHeight - calloutHeight) / 2), left, arrowOffset, direction: 'none' };
}

const STORAGE_KEY = 'coach_tutorial_suppressed';

let tutorialActive = false;
let calloutQueue: CalloutItem[] = [];
let calloutRunning = false;
let calloutStarted = false; // true only after the help modal has been dismissed

export function isTutorialActive(): boolean {
  return tutorialActive;
}

export function initTutorial(): void {
  if (localStorage.getItem(STORAGE_KEY) === 'true') {
    tutorialActive = false;
    return;
  }
  tutorialActive = true;
  calloutQueue = [];
  calloutRunning = false;
  calloutStarted = false;

  const modal = document.getElementById('general-help-modal') as HTMLDialogElement;
  const closeBtn = document.getElementById('general-help-close-btn') as HTMLButtonElement;
  const suppressCb = document.getElementById('tutorial-suppress-cb') as HTMLInputElement;

  modal.showModal();

  const onClose = (): void => {
    modal.removeEventListener('close', onClose);
    if (suppressCb.checked) localStorage.setItem(STORAGE_KEY, 'true');
    calloutStarted = true;
    advanceCallout();
  };

  modal.addEventListener('close', onClose);
  closeBtn.addEventListener('click', () => modal.close(), { once: true });
}

export function appendCallouts(items: CalloutItem[]): void {
  if (!tutorialActive) return;
  calloutQueue.push(...items);
  if (calloutStarted && !calloutRunning) advanceCallout();
}

/** Reset module state for unit tests. Sets tutorialActive and calloutStarted true. */
export function _resetForTest(): void {
  calloutQueue = [];
  calloutRunning = false;
  calloutStarted = true;
  tutorialActive = true;
}

function advanceCallout(): void {
  let item: CalloutItem | undefined;
  let target: HTMLElement | null = null;
  while ((item = calloutQueue.shift()) !== undefined) {
    target = document.getElementById(item.id);
    if (target !== null) break;
    target = null;
  }
  if (item === undefined || target === null) {
    calloutRunning = false;
    return;
  }
  calloutRunning = true;
  showCallout(item, target);
}

function showCallout(item: CalloutItem, target: HTMLElement): void {
  const callout = document.getElementById('callout') as HTMLElement;
  const textEl = document.getElementById('callout-text') as HTMLElement;
  const gotItBtn = document.getElementById('callout-got-it') as HTMLButtonElement;

  textEl.textContent = item.text;
  positionCallout(callout, target);
  callout.hidden = false;

  const onClick = (): void => {
    gotItBtn.removeEventListener('click', onClick);
    callout.hidden = true;
    advanceCallout();
  };
  gotItBtn.addEventListener('click', onClick, { once: true });
}

function positionCallout(callout: HTMLElement, target: HTMLElement): void {
  const rect = target.getBoundingClientRect();
  const pos = calcCalloutPosition(
    callout.offsetWidth || 260,
    callout.offsetHeight || 80,
    rect,
    window.innerWidth,
    window.innerHeight,
  );
  callout.style.top = `${pos.top}px`;
  callout.style.left = `${pos.left}px`;
  callout.style.transform = '';
  callout.style.setProperty('--arrow-offset', `${pos.arrowOffset}px`);
  callout.classList.remove('callout-above', 'callout-below', 'callout-no-arrow');
  callout.classList.add(
    pos.direction === 'above' ? 'callout-above' :
    pos.direction === 'below' ? 'callout-below' : 'callout-no-arrow',
  );
}
