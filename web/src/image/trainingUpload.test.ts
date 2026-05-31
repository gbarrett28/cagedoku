// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { hasConsent, grantConsent, uploadTrainingData, initiateUpload, submitPuzzleReport } from './trainingUpload.js';

function clearCookies(): void {
  document.cookie.split(';').forEach(c => {
    const key = c.split('=')[0]!.trim();
    if (key) document.cookie = `${key}=; max-age=0`;
  });
}

describe('hasConsent', () => {
  beforeEach(clearCookies);

  it('returns false when no consent cookie exists', () => {
    expect(hasConsent()).toBe(false);
  });

  it('returns true when training_consent=granted cookie is set', () => {
    document.cookie = 'training_consent=granted';
    expect(hasConsent()).toBe(true);
  });

  it('returns false when cookie has a different value', () => {
    document.cookie = 'training_consent=declined';
    expect(hasConsent()).toBe(false);
  });
});

describe('grantConsent', () => {
  beforeEach(clearCookies);
  afterEach(clearCookies);

  it('sets the consent cookie so hasConsent() returns true', () => {
    expect(hasConsent()).toBe(false);
    grantConsent();
    expect(hasConsent()).toBe(true);
  });
});

const minimalExport = {
  version: 1 as const,
  exportedAt: '2026-05-07T00:00:00.000Z',
  appVersion: 'test',
  puzzleType: 'killer' as const,
  subres: 128,
  thumbnailSize: 64,
  sampleCount: 0,
  samples: [],
};

describe('uploadTrainingData', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('POSTs JSON to the worker URL when VITE_TRAINING_WORKER_URL is set', () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));

    uploadTrainingData(minimalExport);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://test-worker.example.com',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
  });

  it('does not call fetch when VITE_TRAINING_WORKER_URL is empty', () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    uploadTrainingData(minimalExport);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not throw when fetch rejects', async () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    expect(() => uploadTrainingData(minimalExport)).not.toThrow();
    // Drain microtask queue so the rejection is handled before the test exits.
    await new Promise(r => setTimeout(r, 0));
  });
});

describe('initiateUpload', () => {
  beforeEach(clearCookies);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearCookies(); });

  it('calls uploadTrainingData directly when consent cookie is set', () => {
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));
    const showModal = vi.fn();

    initiateUpload(minimalExport, showModal);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(showModal).not.toHaveBeenCalled();
  });

  it('calls showConsentModal when no consent cookie is set', () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const showModal = vi.fn();

    initiateUpload(minimalExport, showModal);

    expect(showModal).toHaveBeenCalledOnce();
    expect(showModal).toHaveBeenCalledWith(minimalExport);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const minimalStallReport = {
  reason: 'stall' as const,
  puzzleType: 'killer' as const,
  regions: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r)),
  cageTotals: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
  stalledCandidates: Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => [1, 2, 3]),
  ),
};

const minimalRuleBugReport = {
  reason: 'rule-bug' as const,
  puzzleType: 'classic' as const,
  regions: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r)),
  cageTotals: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
  stalledCandidates: Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => [1, 2, 3]),
  ),
  ruleName: 'TestRule',
  offendingEliminations: [{ cell: [0, 0] as [number, number], digit: 5 }],
  goldenSolution: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (__, c) => ((r * 3 + Math.floor(r / 3) + c) % 9) + 1)),
  actions: [] as [],
  givenDigits: null,
};

describe('submitPuzzleReport', () => {
  beforeEach(clearCookies);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearCookies(); });

  it('POSTs a stall report when consent is granted', () => {
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));

    submitPuzzleReport(minimalStallReport);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://test-worker.example.com',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POSTs a rule-bug report when consent is granted', () => {
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));

    submitPuzzleReport(minimalRuleBugReport);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('adds version/reportedAt/appVersion/userAgent envelope fields', () => {
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));

    submitPuzzleReport(minimalStallReport);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body['version']).toBe(1);
    expect(typeof body['reportedAt']).toBe('string');
    expect(typeof body['appVersion']).toBe('string');
    expect(typeof body['userAgent']).toBe('string');
  });

  it('silently drops the report when no consent and no modal provided', () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    submitPuzzleReport(minimalStallReport);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls showConsentModal when no consent and modal is provided', () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const showModal = vi.fn();

    submitPuzzleReport(minimalStallReport, showModal);

    expect(showModal).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not call fetch when VITE_TRAINING_WORKER_URL is empty (even with consent)', () => {
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    submitPuzzleReport(minimalStallReport);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
