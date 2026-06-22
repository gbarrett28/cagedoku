// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { hasConsent, grantConsent, revokeConsent, uploadTrainingData, initiateUpload, submitStallReport, submitRuleBugReport, submitTriggerMissReport } from './trainingUpload.js';
import { saveSettings } from '../session/settings.js';
import { drainTelemetryFailure } from '../session/store.js';

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

describe('revokeConsent', () => {
  beforeEach(clearCookies);
  afterEach(clearCookies);

  it('clears the consent cookie so hasConsent() returns false', () => {
    grantConsent();
    expect(hasConsent()).toBe(true);
    revokeConsent();
    expect(hasConsent()).toBe(false);
  });
});

const minimalExport = {
  reportType: 'training-export' as const,
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
  puzzleType: 'killer' as const,
  stalledCandidates: Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => [1, 2, 3]),
  ),
};

describe('submitStallReport', () => {
  beforeEach(clearCookies);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearCookies(); });

  it('POSTs a stall report when consent is granted', () => {
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));

    submitStallReport(minimalStallReport);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://test-worker.example.com',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('adds reportType/reportedAt/appVersion/userAgent envelope fields', () => {
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));

    submitStallReport(minimalStallReport);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body['reportType']).toBe('stall');
    expect(typeof body['reportedAt']).toBe('string');
    expect(typeof body['appVersion']).toBe('string');
    expect(typeof body['userAgent']).toBe('string');
  });

  it('silently drops the report when consent is absent', () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    submitStallReport(minimalStallReport);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not call fetch when VITE_TRAINING_WORKER_URL is empty (even with consent)', () => {
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    submitStallReport(minimalStallReport);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const minimalRuleBugReport = {
  puzzleType: 'classic' as const,
  ruleName: 'TestRule',
  offendingEliminations: [{ cell: [0, 0] as [number, number], digit: 5 }],
  state: {
    kind: 'classic' as const,
    version: 1 as const,
    userGrid: Array.from({ length: 9 }, () => new Array<number>(9).fill(0)),
    turns: [],
    alwaysApplyRules: [],
    goldenSolution: Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (__, c) => ((r * 3 + Math.floor(r / 3) + c) % 9) + 1)),
    givenDigits: null,
    originalImageUrl: null,
    userRemovedCandidates: [],
  },
};

describe('submitRuleBugReport', () => {
  beforeEach(clearCookies);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearCookies(); });

  it('POSTs a rule-bug report with reportType when consent is granted', () => {
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));

    submitRuleBugReport(minimalRuleBugReport);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body['reportType']).toBe('rule-bug');
    expect(typeof body['reportedAt']).toBe('string');
    expect(typeof body['appVersion']).toBe('string');
    expect(typeof body['userAgent']).toBe('string');
  });

  it('silently drops the report when consent is absent', () => {
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    submitRuleBugReport(minimalRuleBugReport);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const minimalTriggerMissReport = {
  puzzleType: 'classic' as const,
  ruleName: 'TestRule',
  missedContext: 'box 3',
  missedEliminations: [{ cell: [0, 0] as [number, number], digit: 5 }],
  state: minimalRuleBugReport.state,
};

describe('dev telemetry-failure surfacing', () => {
  beforeEach(() => { clearCookies(); localStorage.clear(); drainTelemetryFailure(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearCookies(); localStorage.clear(); drainTelemetryFailure(); });

  function enableDevFlag(): void {
    saveSettings({ alwaysApplyRules: [], autoPlacementDelay: 0, showCandidatesByDefault: true, devSurfaceTelemetryFailures: true });
  }

  it('does nothing when the dev flag is off (default) and consent is absent', () => {
    submitRuleBugReport(minimalRuleBugReport);
    expect(drainTelemetryFailure()).toBeNull();
  });

  it('queues a message when consent is absent and the dev flag is on (rule-bug)', () => {
    enableDevFlag();
    submitRuleBugReport(minimalRuleBugReport);
    expect(drainTelemetryFailure()).toMatch(/rule-bug.*consent/i);
  });

  it('queues a message when consent is absent and the dev flag is on (trigger-miss)', () => {
    enableDevFlag();
    submitTriggerMissReport(minimalTriggerMissReport);
    expect(drainTelemetryFailure()).toMatch(/trigger-miss.*consent/i);
  });

  it('queues a message when the upload itself rejects and the dev flag is on', async () => {
    enableDevFlag();
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    submitRuleBugReport(minimalRuleBugReport);
    await new Promise(r => setTimeout(r, 0));

    expect(drainTelemetryFailure()).toMatch(/rule-bug.*network down/i);
  });

  it('does not queue anything for report types outside rule-bug/trigger-miss', async () => {
    enableDevFlag();
    document.cookie = 'training_consent=granted';
    vi.stubEnv('VITE_TRAINING_WORKER_URL', 'https://test-worker.example.com');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    submitStallReport(minimalStallReport);
    await new Promise(r => setTimeout(r, 0));

    expect(drainTelemetryFailure()).toBeNull();
  });
});
