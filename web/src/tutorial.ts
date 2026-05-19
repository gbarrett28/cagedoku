export interface CalloutItem {
  id: string;
  text: string;
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

function advanceCallout(): void {
  const item = calloutQueue.shift();
  if (item === undefined) {
    calloutRunning = false;
    return;
  }
  calloutRunning = true;
  const target = document.getElementById(item.id);
  if (target === null) {
    advanceCallout(); // skip missing elements
    return;
  }
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
  callout.style.position = 'fixed';
  // Position above the target; fall back to below if too close to top
  const spaceAbove = rect.top;
  if (spaceAbove > 80) {
    callout.style.top = `${rect.top - 8}px`;
    callout.style.transform = 'translateY(-100%)';
  } else {
    callout.style.top = `${rect.bottom + 8}px`;
    callout.style.transform = 'none';
  }
  callout.style.left = `${Math.max(8, rect.left)}px`;
}
