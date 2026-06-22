import type { TrainingExport } from '../../../shared/src/reports/TrainingExport.js';
import type { StallStateExport } from '../../../shared/src/reports/StallStateExport.js';
import type { RuleBugReport } from '../../../shared/src/reports/RuleBugReport.js';
import type { TriggerMissReport } from '../../../shared/src/reports/TriggerMissReport.js';
import type { CageThresholdCalibrationReport } from '../../../shared/src/reports/CageThresholdCalibrationReport.js';
import type { AnyReport } from '../../../shared/src/reports/index.js';
import { loadSettings } from '../session/settings.js';
import { enqueueTelemetryFailure } from '../session/store.js';

export type { TrainingExport } from '../../../shared/src/reports/TrainingExport.js';
export type { StallStateExport } from '../../../shared/src/reports/StallStateExport.js';
export type { RuleBugReport } from '../../../shared/src/reports/RuleBugReport.js';
export type { TriggerMissReport } from '../../../shared/src/reports/TriggerMissReport.js';
export type { CageThresholdCalibrationReport } from '../../../shared/src/reports/CageThresholdCalibrationReport.js';

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

export function revokeConsent(): void {
  document.cookie = `${CONSENT_COOKIE}=; max-age=0`;
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
    surfaceTelemetryFailure(data.reportType, err instanceof Error ? err.message : String(err));
  });
}

/**
 * Surfaces rule-bug/trigger-miss telemetry failures by forcing open a
 * prefilled bug report instead of dropping them silently — gated behind the
 * dev-only `devSurfaceTelemetryFailures` setting (default off) so normal
 * users never see this. Other report types (stall, training export,
 * calibration) already have either an explicit consent-modal recourse or no
 * regression-test consequence, so they are out of scope here.
 */
function surfaceTelemetryFailure(reportType: AnyReport['reportType'], reason: string): void {
  if (reportType !== 'rule-bug' && reportType !== 'trigger-miss') return;
  if (!loadSettings().devSurfaceTelemetryFailures) return;
  enqueueTelemetryFailure(`Telemetry upload failed (${reportType}): ${reason}`);
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
  if (!hasConsent()) {
    surfaceTelemetryFailure('rule-bug', 'training consent not granted; report was dropped');
    return;
  }
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
  if (!hasConsent()) {
    surfaceTelemetryFailure('trigger-miss', 'training consent not granted; report was dropped');
    return;
  }
  const payload: TriggerMissReport = {
    reportType: 'trigger-miss',
    reportedAt: new Date().toISOString(),
    appVersion: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    ...report,
  };
  postToWorker(payload);
}

/** Submit a cage-threshold-calibration report. Silently dropped when consent is absent. */
export function submitCageThresholdCalibrationReport(
  report: Omit<CageThresholdCalibrationReport, 'reportType' | 'reportedAt' | 'appVersion' | 'userAgent'>,
): void {
  if (!hasConsent()) return;
  const payload: CageThresholdCalibrationReport = {
    reportType: 'cage-threshold-calibration',
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
