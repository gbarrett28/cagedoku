import { describe, expect, it } from 'vitest';
import { aggregateReport } from './corpusEvalReport.js';
import type { EvalRecord } from './corpusEvalReport.js';

function record(overrides: Partial<EvalRecord>): EvalRecord {
  return {
    filename: 'x.jpg',
    bucket: 'clean',
    reason: 'auto_confirmed',
    puzzleType: 'killer',
    detectedBigApple: false,
    elapsedMs: 100,
    timestamp: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('aggregateReport', () => {
  it('counts each bucket correctly', () => {
    const records = [
      record({ bucket: 'clean' }),
      record({ bucket: 'clean' }),
      record({ bucket: 'backtracked' }),
      record({ bucket: 'notSolved', reason: 'layout errors' }),
    ];
    const summary = aggregateReport(records);
    expect(summary.total).toBe(4);
    expect(summary.counts).toEqual({ clean: 2, backtracked: 1, notSolved: 1 });
  });

  it('computes percentages relative to total', () => {
    const records = [
      record({ bucket: 'clean' }),
      record({ bucket: 'clean' }),
      record({ bucket: 'notSolved', reason: 'sum warning' }),
    ];
    const summary = aggregateReport(records);
    expect(summary.percentages.clean).toBeCloseTo(66.667, 2);
    expect(summary.percentages.notSolved).toBeCloseTo(33.333, 2);
  });

  it('breaks down notSolved reasons by frequency', () => {
    const records = [
      record({ bucket: 'notSolved', reason: 'layout errors' }),
      record({ bucket: 'notSolved', reason: 'layout errors' }),
      record({ bucket: 'notSolved', reason: 'sum warning' }),
    ];
    const summary = aggregateReport(records);
    expect(summary.notSolvedReasons).toEqual({ 'layout errors': 2, 'sum warning': 1 });
  });

  it('returns zeroed percentages and an empty reason breakdown for no records', () => {
    const summary = aggregateReport([]);
    expect(summary.total).toBe(0);
    expect(summary.counts).toEqual({ clean: 0, backtracked: 0, notSolved: 0 });
    expect(summary.percentages).toEqual({ clean: 0, backtracked: 0, notSolved: 0 });
    expect(summary.notSolvedReasons).toEqual({});
  });
});
