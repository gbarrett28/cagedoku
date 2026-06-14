export { TrainingExport } from './TrainingExport.js';
export type { TrainingSample } from './TrainingExport.js';
export { PuzzleSpecExport } from './PuzzleSpecExport.js';
export { StallStateExport } from './StallStateExport.js';
export { FeedbackReport } from './FeedbackReport.js';
export { RuleBugReport } from './RuleBugReport.js';
export { TriggerMissReport } from './TriggerMissReport.js';
export type { TriggerMissReproductionBundle } from './TriggerMissReport.js';
export { CageThresholdCalibrationReport } from './CageThresholdCalibrationReport.js';

import type { TrainingExport } from './TrainingExport.js';
import type { PuzzleSpecExport } from './PuzzleSpecExport.js';
import type { StallStateExport } from './StallStateExport.js';
import type { FeedbackReport } from './FeedbackReport.js';
import type { RuleBugReport } from './RuleBugReport.js';
import type { TriggerMissReport } from './TriggerMissReport.js';
import type { CageThresholdCalibrationReport } from './CageThresholdCalibrationReport.js';
import { RuleBugReport as RBR } from './RuleBugReport.js';
import { TriggerMissReport as TMR } from './TriggerMissReport.js';
import { FeedbackReport as FR } from './FeedbackReport.js';
import { StallStateExport as SSE } from './StallStateExport.js';
import { PuzzleSpecExport as PSE } from './PuzzleSpecExport.js';
import { TrainingExport as TE } from './TrainingExport.js';
import { CageThresholdCalibrationReport as CTCR } from './CageThresholdCalibrationReport.js';

export type AnyReport =
  | TrainingExport
  | PuzzleSpecExport
  | StallStateExport
  | FeedbackReport
  | RuleBugReport
  | TriggerMissReport
  | CageThresholdCalibrationReport;

/**
 * Parse an unknown value as any known report type. Returns null if none match.
 * Validators are tried in specificity order — more-discriminating checks first.
 */
export function parseAnyReport(value: unknown): AnyReport | null {
  if (CTCR.is(value)) return value;
  if (RBR.is(value)) return value;
  if (TMR.is(value)) return value;
  if (FR.is(value)) return value;
  if (SSE.is(value)) return value;
  if (PSE.is(value)) return value;
  if (TE.is(value)) return value;
  return null;
}

/**
 * Exhaustiveness guard for switch statements over AnyReport.reportType.
 * Place in the default branch: assertNeverReport(report);
 */
export function assertNeverReport(report: never): never {
  throw new Error(`Unhandled report type: ${(report as { reportType: string }).reportType}`);
}
