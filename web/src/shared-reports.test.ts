import { describe, it, expect } from 'vitest';
import { parseAnyReport, assertNeverReport, FeedbackReport } from '../../shared/src/reports/index.js';

const grid9x9 = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (__, c) => ((r * 3 + Math.floor(r / 3) + c) % 9) + 1));
const candidates9x9 = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => [1, 2, 3]));

const state = {
  kind: 'classic',
  version: 1,
  userGrid: grid9x9,
  turns: [],
  alwaysApplyRules: [],
  goldenSolution: grid9x9,
  givenDigits: null,
  originalImageUrl: null,
  userRemovedCandidates: [],
};

const base = {
  reportedAt: '2026-01-01T00:00:00.000Z',
  appVersion: '2026-01-01',
  userAgent: 'test',
};

describe('parseAnyReport', () => {
  it('returns null for null', () => {
    expect(parseAnyReport(null)).toBeNull();
  });

  it('returns null for an empty object', () => {
    expect(parseAnyReport({})).toBeNull();
  });

  it('returns null for an unknown reportType', () => {
    expect(parseAnyReport({ ...base, reportType: 'unknown' })).toBeNull();
  });

  it('round-trips a training-export report', () => {
    const r = {
      reportType: 'training-export',
      exportedAt: '2026-01-01T00:00:00.000Z',
      appVersion: '2026-01-01',
      puzzleType: 'killer',
      subres: 128,
      thumbnailSize: 64,
      sampleCount: 0,
      samples: [],
    };
    const parsed = parseAnyReport(r);
    expect(parsed).not.toBeNull();
    expect(parsed!.reportType).toBe('training-export');
  });

  it('round-trips a stall report', () => {
    const r = {
      ...base,
      reportType: 'stall',
      puzzleType: 'killer',
      stalledCandidates: candidates9x9,
    };
    const parsed = parseAnyReport(r);
    expect(parsed).not.toBeNull();
    expect(parsed!.reportType).toBe('stall');
  });

  it('round-trips a rule-bug report', () => {
    const r = {
      ...base,
      reportType: 'rule-bug',
      ruleName: 'TestRule',
      offendingEliminations: [{ cell: [0, 0], digit: 5 }],
      puzzleType: 'classic',
      state,
    };
    const parsed = parseAnyReport(r);
    expect(parsed).not.toBeNull();
    expect(parsed!.reportType).toBe('rule-bug');
  });

  it('round-trips a trigger-miss report', () => {
    const r = {
      ...base,
      reportType: 'trigger-miss',
      ruleName: 'TestRule',
      missedContext: 'GLOBAL',
      missedEliminations: [{ cell: [0, 0], digit: 3 }],
      puzzleType: 'killer',
      state,
    };
    const parsed = parseAnyReport(r);
    expect(parsed).not.toBeNull();
    expect(parsed!.reportType).toBe('trigger-miss');
  });

  it('round-trips a cage-threshold-calibration report', () => {
    const r = {
      ...base,
      reportType: 'cage-threshold-calibration',
      chosenThreshold: 0.3,
      fallbackUsed: false,
      candidates: [
        { threshold: 0.1, valid: false, margin: 0.05 },
        { threshold: 0.3, valid: true, margin: 0.12 },
      ],
      contourFillRatios: [0.15, 0.81, 0.2],
    };
    const parsed = parseAnyReport(r);
    expect(parsed).not.toBeNull();
    expect(parsed!.reportType).toBe('cage-threshold-calibration');
  });

  it('returns null for a cage-threshold-calibration report missing contourFillRatios', () => {
    const r = {
      ...base,
      reportType: 'cage-threshold-calibration',
      chosenThreshold: 0.3,
      fallbackUsed: false,
      candidates: [],
    };
    expect(parseAnyReport(r)).toBeNull();
  });

  it('round-trips a feedback report', () => {
    const r = {
      ...base,
      reportType: 'feedback',
      feedbackType: 'bug',
      description: 'Something broke',
      actionLog: 'action1\naction2',
      puzzleSpec: null,
      viewport: '1280x800',
      config: { alwaysApplyRules: [], autoPlacementDelay: 0 },
    };
    const parsed = parseAnyReport(r);
    expect(parsed).not.toBeNull();
    expect(parsed!.reportType).toBe('feedback');
  });
});

describe('FeedbackReport.githubAction', () => {
  const feedbackBase = {
    ...base,
    reportType: 'feedback' as const,
    feedbackType: 'bug' as const,
    description: 'Something broke',
    actionLog: 'action1\naction2',
    puzzleSpec: null,
    viewport: '1280x800',
    config: { alwaysApplyRules: [], autoPlacementDelay: 0 },
  };

  it('includes an "Active hint" section with the JSON snapshot when activeHint is set', () => {
    const activeHint = { ruleName: 'HiddenSingle', displayName: 'Hidden Single', explanation: 'x' };
    const report: FeedbackReport = { ...feedbackBase, activeHint };
    const { body } = FeedbackReport.githubAction(report);
    expect(body).toContain('Active hint');
    expect(body).toContain('"ruleName": "HiddenSingle"');
  });

  it('omits the "Active hint" section when activeHint is not set', () => {
    const report: FeedbackReport = { ...feedbackBase };
    const { body } = FeedbackReport.githubAction(report);
    expect(body).not.toContain('Active hint');
  });
});

describe('assertNeverReport', () => {
  it('throws when called with an unhandled report type', () => {
    expect(() => assertNeverReport({ reportType: 'bogus' } as never)).toThrow('Unhandled report type: bogus');
  });
});
