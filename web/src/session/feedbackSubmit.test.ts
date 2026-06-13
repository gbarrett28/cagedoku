import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildFeedbackPayload, submitFeedback } from './feedbackSubmit.js';
import type { FeedbackPayloadParams } from './feedbackSubmit.js';
import { parseAnyReport } from '../../../shared/src/reports/index.js';

const baseParams: FeedbackPayloadParams = {
  feedbackType: 'bug',
  bugCategory: 'wrong-behaviour',
  description: 'The hint was incorrect',
  actionLog: 'load\nhint',
  puzzleSpec: null,
  viewport: '1280x800',
  config: { alwaysApplyRules: [], autoPlacementDelay: 0 },
  appVersion: '2026-06-13 10:00',
  userAgent: 'test-agent',
};

describe('buildFeedbackPayload', () => {
  it.each<[string, FeedbackPayloadParams]>([
    ['bug / wrong-behaviour', { ...baseParams, feedbackType: 'bug', bugCategory: 'wrong-behaviour' }],
    ['bug / inaccurate-description', { ...baseParams, feedbackType: 'bug', bugCategory: 'inaccurate-description' }],
    ['enhancement', (() => { const { bugCategory: _b, ...rest } = baseParams; return { ...rest, feedbackType: 'enhancement' as const }; })()],
    ['new-rule', (() => { const { bugCategory: _b, ...rest } = baseParams; return { ...rest, feedbackType: 'new-rule' as const }; })()],
  ])('produces a payload parseAnyReport recognises as feedback (%s)', (_label, params) => {
    const payload = buildFeedbackPayload(params);
    const parsed = parseAnyReport(payload);
    expect(parsed?.reportType).toBe('feedback');
  });

  it('omits optional fields entirely when not provided', () => {
    const { bugCategory: _b, ...rest } = baseParams;
    const payload = buildFeedbackPayload({ ...rest, feedbackType: 'enhancement' });
    expect('bugCategory' in payload).toBe(false);
    expect('expected' in payload).toBe(false);
    expect('exception' in payload).toBe(false);
    expect('fixtureName' in payload).toBe(false);
    expect('unsolvedCells' in payload).toBe(false);
    expect('totalCandidates' in payload).toBe(false);
  });

  it('includes expected, exception, and fixture-context fields when provided', () => {
    const payload = buildFeedbackPayload({
      ...baseParams,
      expected: 'The hint should say X',
      exception: 'TypeError: boom',
      fixtureContext: { name: 'TwoStringKite-1', unsolvedCells: 12, totalCandidates: 34 },
    });
    expect(payload.expected).toBe('The hint should say X');
    expect(payload.exception).toBe('TypeError: boom');
    expect(payload.fixtureName).toBe('TwoStringKite-1');
    expect(payload.unsolvedCells).toBe(12);
    expect(payload.totalCandidates).toBe(34);
  });
});

describe('submitFeedback', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('returns { kind: "logged" } and does not call fetch when no worker URL is configured', async () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await submitFeedback(buildFeedbackPayload(baseParams));

    expect(result).toEqual({ kind: 'logged' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns { kind: "success" } when fetch resolves ok', async () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://worker.example.com');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }));

    const result = await submitFeedback(buildFeedbackPayload(baseParams));

    expect(result).toEqual({ kind: 'success' });
  });

  it('returns { kind: "http-error" } with status and body when fetch resolves not-ok', async () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://worker.example.com');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Bad request: unrecognised schema', { status: 400 }),
    );

    const result = await submitFeedback(buildFeedbackPayload(baseParams));

    expect(result).toEqual({ kind: 'http-error', status: 400, body: 'Bad request: unrecognised schema' });
  });

  it('returns { kind: "network-error" } when fetch rejects', async () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://worker.example.com');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await submitFeedback(buildFeedbackPayload(baseParams));

    expect(result.kind).toBe('network-error');
    expect((result as { kind: 'network-error'; message: string }).message).toContain('Failed to fetch');
  });
});
