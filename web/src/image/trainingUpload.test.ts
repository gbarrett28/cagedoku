// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { hasConsent, grantConsent, uploadTrainingData, initiateUpload } from './trainingUpload.js';

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
