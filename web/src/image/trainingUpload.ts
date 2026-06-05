import type { TrainingExport } from './trainingExport.js';

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

export type PuzzleReport = StallReport;

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

// ---------------------------------------------------------------------------
// Trigger miss report — background validator finding unfired rule triggers
// ---------------------------------------------------------------------------

/**
 * Sent when the brute-force background validator finds a rule that produces
 * actionable candidate eliminations after the normal solve pass has run to a
 * fixed point. This indicates the trigger/queue system failed to enqueue the
 * rule for a context where it would have made progress.
 *
 * Uses version 5 to match the worker schema (separate from PuzzleReport v1).
 */
export interface TriggerMissReport {
  version: 5;
  feedbackType: 'trigger-miss';
  reportedAt: string;
  appVersion: string;
  userAgent: string;
  ruleName: string;
  /** Context where the miss was found, e.g. "GLOBAL" or "COUNT_DECREASED:ROW:3". */
  missedContext: string;
  missedEliminations: Array<{ cell: [number, number]; digit: number }>;
  /** 9×9 candidate grid at the time the miss was detected. */
  stalledCandidates: number[][][];
  goldenSolution: number[][];
  puzzleType: 'killer' | 'classic';
  regions: number[][];
  cageTotals: number[][];
}

/**
 * Submit a trigger-miss report. Silently dropped when consent is absent —
 * showing a modal during background validation would be disruptive.
 */
export function submitTriggerMissReport(
  report: Omit<TriggerMissReport, 'version' | 'feedbackType' | 'reportedAt' | 'appVersion' | 'userAgent'>,
): void {
  if (!hasConsent()) return;
  const payload: TriggerMissReport = {
    version: 5,
    feedbackType: 'trigger-miss',
    reportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    ...report,
  };
  postToWorker(payload);
}

// ---------------------------------------------------------------------------
// Rule bug report — sent when a rule eliminates a golden-solution digit
// ---------------------------------------------------------------------------

/**
 * Matches the worker's RuleBugReport schema (version 4).
 * Sent both when SolverEngine's onViolation fires (rule fired + was wrong)
 * and when the brute-force background validator finds a rule that would
 * produce a golden violation but whose trigger never fired.
 */
export interface WorkerRuleBugReport {
  version: 4;
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
  userAgent: string;
}

/** Submit a rule-bug report. Silently dropped when consent is absent. */
export function submitRuleBugReport(
  report: Omit<WorkerRuleBugReport, 'version' | 'feedbackType' | 'reportedAt' | 'appVersion' | 'userAgent'>,
): void {
  if (!hasConsent()) return;
  const payload: WorkerRuleBugReport = {
    version: 4,
    feedbackType: 'rule-bug',
    reportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    ...report,
  };
  postToWorker(payload);
}

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------

/** Fire-and-forget POST to the Cloudflare Worker. Network errors are swallowed
 *  intentionally — a failed upload must never interrupt the solve flow. */
function postToWorker(data: TrainingExport | PuzzleReport | TriggerMissReport | WorkerRuleBugReport): void {
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
  report: Omit<PuzzleReport, 'version' | 'reportedAt' | 'appVersion' | 'userAgent'>,
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
  };
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
