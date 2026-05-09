import type { PuzzleSpecExport, TrainingExport } from './trainingExport.js';

const CONSENT_COOKIE = 'training_consent';

export function hasConsent(): boolean {
  return document.cookie.split(';').some(c => c.trim() === `${CONSENT_COOKIE}=granted`);
}

export function grantConsent(): void {
  document.cookie = `${CONSENT_COOKIE}=granted; max-age=31536000; SameSite=Strict`;
}

/** Check consent and either upload immediately or delegate to a modal. */
export function initiateUpload(
  data: TrainingExport,
  showConsentModal: (data: TrainingExport) => void,
): void {
  if (hasConsent()) {
    uploadTrainingData(data);
  } else {
    showConsentModal(data);
  }
}

/** Fire-and-forget POST to the Cloudflare Worker. Network errors are swallowed
 *  intentionally — a failed upload must never interrupt the solve flow. */
function postToWorker(data: TrainingExport | PuzzleSpecExport): void {
  const workerUrl = import.meta.env['VITE_TRAINING_WORKER_URL'] as string | undefined;
  if (!workerUrl) return;
  void fetch(workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch((err: unknown) => {
    console.error('[trainingUpload] upload failed:', err);
  });
}

export function uploadTrainingData(data: TrainingExport): void {
  postToWorker(data);
}

/** Upload a puzzle spec that required MRV backtracking — if consent is already
 *  granted.  Does not show the consent modal; the spec is low-priority signal
 *  that silently piggybacks on existing consent. */
export function uploadPuzzleSpec(data: PuzzleSpecExport): void {
  if (!hasConsent()) return;
  postToWorker(data);
}
