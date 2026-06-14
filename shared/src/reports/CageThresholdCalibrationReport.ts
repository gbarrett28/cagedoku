import type { ReportBase } from '../report.js';

/** Per-candidate calibration outcome — mirrors `ThresholdCandidateResult` in cellScan.ts. */
export interface CageThresholdCandidateResult {
  readonly threshold: number;
  readonly valid: boolean;
  readonly margin: number;
}

/**
 * Telemetry for per-image cage-total fill-ratio calibration
 * (`calibrateCageTotalThreshold` in `web/src/image/cellScan.ts`).
 *
 * Captures the chosen threshold, whether the fallback was used, the full
 * candidate sweep, and the raw flattened contour fill ratios — enough data to
 * re-tune the candidate sweep or margin rule from real-world images later.
 */
export interface CageThresholdCalibrationReport extends ReportBase {
  readonly reportType: 'cage-threshold-calibration';
  readonly chosenThreshold: number;
  readonly fallbackUsed: boolean;
  readonly candidates: readonly CageThresholdCandidateResult[];
  readonly contourFillRatios: readonly number[];
}

export namespace CageThresholdCalibrationReport {
  export function is(value: unknown): value is CageThresholdCalibrationReport {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (v['reportType'] !== 'cage-threshold-calibration') return false;
    if (typeof v['reportedAt'] !== 'string') return false;
    if (typeof v['appVersion'] !== 'string') return false;
    if (typeof v['userAgent'] !== 'string') return false;
    if (typeof v['chosenThreshold'] !== 'number') return false;
    if (typeof v['fallbackUsed'] !== 'boolean') return false;
    if (!isCandidates(v['candidates'])) return false;
    if (!isNumberArray(v['contourFillRatios'])) return false;
    return true;
  }

  function isCandidates(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return (value as unknown[]).every(c => {
      if (typeof c !== 'object' || c === null) return false;
      const cv = c as Record<string, unknown>;
      return typeof cv['threshold'] === 'number'
        && typeof cv['valid'] === 'boolean'
        && typeof cv['margin'] === 'number';
    });
  }

  function isNumberArray(value: unknown): boolean {
    return Array.isArray(value) && (value as unknown[]).every(x => typeof x === 'number');
  }

  export function storageKey(r: CageThresholdCalibrationReport, uuid: string): string {
    return `cage-threshold-calibration/${r.reportedAt}-${uuid}.json`;
  }

  export function r2Metadata(r: CageThresholdCalibrationReport): Record<string, string> {
    return {
      appVersion: r.appVersion,
      chosenThreshold: String(r.chosenThreshold),
      fallbackUsed: String(r.fallbackUsed),
    };
  }
}
