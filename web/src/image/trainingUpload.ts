import type { TrainingExport } from '../../../shared/src/reports/TrainingExport.js';
import type { StallStateExport } from '../../../shared/src/reports/StallStateExport.js';
import type { RuleBugReport } from '../../../shared/src/reports/RuleBugReport.js';
import type { TriggerMissReport } from '../../../shared/src/reports/TriggerMissReport.js';
import type { AnyReport } from '../../../shared/src/reports/index.js';

export type { TrainingExport } from '../../../shared/src/reports/TrainingExport.js';
export type { StallStateExport } from '../../../shared/src/reports/StallStateExport.js';
export type { RuleBugReport } from '../../../shared/src/reports/RuleBugReport.js';
export type { TriggerMissReport } from '../../../shared/src/reports/TriggerMissReport.js';

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
// Core upload helper
// ---------------------------------------------------------------------------

/** Fire-and-forget POST to the Cloudflare Worker. Network errors are swallowed
 *  intentionally — a failed upload must never interrupt the solve flow. */
function postToWorker(data: AnyReport | TrainingExport): void {
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

// ---------------------------------------------------------------------------
// Per-type submit helpers
// ---------------------------------------------------------------------------

/**
 * Submit a stall-state report. Silently dropped when consent is absent —
 * showing a modal during background validation would be disruptive.
 */
export function submitStallReport(
  report: Omit<StallStateExport, 'reportType' | 'reportedAt' | 'appVersion' | 'userAgent'>,
): void {
  if (!hasConsent()) return;
  const payload: StallStateExport = {
    reportType: 'stall',
    reportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    ...report,
  };
  postToWorker(payload);
}

/** Submit a rule-bug report. Silently dropped when consent is absent. */
export function submitRuleBugReport(
  report: Omit<RuleBugReport, 'reportType' | 'reportedAt' | 'appVersion' | 'userAgent'>,
): void {
  if (!hasConsent()) return;
  const payload: RuleBugReport = {
    reportType: 'rule-bug',
    reportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    ...report,
  };
  postToWorker(payload);
}

/** Submit a trigger-miss report. Silently dropped when consent is absent. */
export function submitTriggerMissReport(
  report: Omit<TriggerMissReport, 'reportType' | 'reportedAt' | 'appVersion' | 'userAgent'>,
): void {
  if (!hasConsent()) return;
  const payload: TriggerMissReport = {
    reportType: 'trigger-miss',
    reportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    ...report,
  };
  postToWorker(payload);
}

// ---------------------------------------------------------------------------
// Training data (digit recogniser)
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
