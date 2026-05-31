import type { PuzzleSpecExport, StallStateExport, TrainingExport } from './trainingExport.js';
import type { UserAction } from '../session/types.js';

export interface RuleBugReport {
  version: 5;
  feedbackType: 'rule-bug';
  reportedAt: string;
  appVersion: string;
  ruleName: string;
  offendingEliminations: Array<{ cell: [number, number]; digit: number }>;
  goldenSolution: number[][];
  stalledCandidates: number[][][];
  puzzleType: 'killer' | 'classic';
  regions: number[][];
  cageTotals: number[][];
  /** Full action history — replay these in order to reproduce the board state. */
  actions: readonly UserAction[];
  /** Pre-filled digits for classic puzzles; null for killer. */
  givenDigits: number[][] | null;
  userAgent: string;
}

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
function postToWorker(data: TrainingExport | PuzzleSpecExport | StallStateExport | RuleBugReport): void {
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

/** Fire-and-forget POST of an automatic rule-bug report. No consent required —
 *  the report contains only the board state and is used for automated debugging.
 *  Safe to call multiple times; duplicate suppression happens at the call site. */
export function submitRuleBugReport(report: Omit<RuleBugReport, 'version' | 'feedbackType' | 'reportedAt' | 'appVersion' | 'userAgent'>): void {
  const workerUrl = import.meta.env['VITE_TRAINING_WORKER_URL'] as string | undefined;
  if (!workerUrl) return;
  const payload: RuleBugReport = {
    version: 5,
    feedbackType: 'rule-bug',
    reportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    ...report,
  };
  postToWorker(payload);
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

/** Fire-and-forget POST of a stall state — assumes consent already granted. */
export function uploadStallState(data: StallStateExport): void {
  postToWorker(data);
}

/** Check consent; if granted POST immediately, otherwise call showConsentModal. */
export function initiateStallUpload(
  data: StallStateExport,
  showConsentModal: () => void,
): void {
  if (hasConsent()) {
    uploadStallState(data);
  } else {
    showConsentModal();
  }
}
