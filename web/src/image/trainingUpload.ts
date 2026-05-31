import type { TrainingExport } from './trainingExport.js';
import type { UserAction } from '../session/types.js';

// ---------------------------------------------------------------------------
// Puzzle report — unified type for all puzzle-state uploads
// ---------------------------------------------------------------------------

interface PuzzleReportBase {
  version: 1;
  reportedAt: string;
  appVersion: string;
  puzzleType: 'killer' | 'classic';
  /** Row-major 9×9 cage index grid. */
  regions: number[][];
  /** Row-major 9×9 cage totals grid. */
  cageTotals: number[][];
  userAgent: string;
}

/**
 * Sent when the rule engine stalls and falls back to MRV backtracking.
 * Captures the candidate grid at stall time for offline rule analysis.
 */
type StallReport = PuzzleReportBase & {
  reason: 'stall';
  /** 9×9 candidate grid at the moment the rule engine stalled. */
  stalledCandidates: number[][][];
};

/**
 * Sent when a rule produces an elimination that contradicts the known golden
 * solution. Includes the full action history so the session can be replayed.
 */
type RuleBugReport = PuzzleReportBase & {
  reason: 'rule-bug';
  ruleName: string;
  offendingEliminations: Array<{ cell: [number, number]; digit: number }>;
  stalledCandidates: number[][][];
  goldenSolution: number[][];
  /** Full turn action history — replay these to reproduce the board state. */
  actions: readonly UserAction[];
  /** Pre-filled digits for classic puzzles; null for killer. */
  givenDigits: number[][] | null;
};

export type PuzzleReport = StallReport | RuleBugReport;

/** Distributes Omit over a union so discriminant fields are preserved. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

const CONSENT_COOKIE = 'training_consent';

export function hasConsent(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split(';').some(c => c.trim() === `${CONSENT_COOKIE}=granted`);
}

export function grantConsent(): void {
  document.cookie = `${CONSENT_COOKIE}=granted; max-age=31536000; SameSite=Strict`;
}

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------

/** Fire-and-forget POST to the Cloudflare Worker. Network errors are swallowed
 *  intentionally — a failed upload must never interrupt the solve flow. */
function postToWorker(data: TrainingExport | PuzzleReport): void {
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

/**
 * Submit a puzzle report. All reports require consent — puzzle data is
 * someone else's IP.
 *
 * If `showConsentModal` is provided and consent has not been granted, it is
 * called instead of sending; the modal should call `submitPuzzleReport` again
 * after the user grants consent.
 *
 * If no `showConsentModal` is provided and consent is absent, the report is
 * silently dropped (acceptable for automatic diagnostic reports where showing
 * a modal mid-solve would be disruptive).
 */
export function submitPuzzleReport(
  report: DistributiveOmit<PuzzleReport, 'version' | 'reportedAt' | 'appVersion' | 'userAgent'>,
  showConsentModal?: () => void,
): void {
  if (!hasConsent()) {
    if (showConsentModal) showConsentModal();
    return;
  }
  const payload: PuzzleReport = {
    version: 1,
    reportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    ...report,
  } as PuzzleReport;
  postToWorker(payload);
}

// ---------------------------------------------------------------------------
// Training data (digit recogniser — separate from puzzle reports)
// ---------------------------------------------------------------------------

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

export function uploadTrainingData(data: TrainingExport): void {
  postToWorker(data);
}
