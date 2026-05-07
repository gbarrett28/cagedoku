import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index.js';
import type { Env } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TRAINING_BUCKET: {
      list: vi.fn().mockResolvedValue({ objects: [] }),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket,
    GITHUB_TOKEN: 'fake-token',
    GITHUB_REPO: 'test/repo',
    GITHUB_ISSUE_NUMBER: '1',
    MAX_PENDING_UPLOADS: '50',
    ENVIRONMENT: 'development',
    ...overrides,
  };
}

function makeRequest(options: {
  method?: string;
  origin?: string;
  contentType?: string;
  body?: unknown;
} = {}): Request {
  const headers: Record<string, string> = {};
  if (options.origin) headers['Origin'] = options.origin;
  if (options.contentType) headers['Content-Type'] = options.contentType;
  return new Request('https://worker.example.com/', {
    method: options.method ?? 'POST',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

const validExport = {
  version: 1,
  exportedAt: '2026-05-07T00:00:00.000Z',
  appVersion: 'test',
  puzzleType: 'killer',
  subres: 128,
  thumbnailSize: 64,
  sampleCount: 1,
  samples: [{ digit: 3, pixels: new Array<number>(4096).fill(128) }],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Worker fetch handler', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 201 }),
    );
  });

  afterEach(() => { vi.restoreAllMocks(); });

  // --- Method -----------------------------------------------------------------

  it('returns 405 for non-POST/OPTIONS requests', async () => {
    const res = await worker.fetch(makeRequest({ method: 'GET' }), makeEnv());
    expect(res.status).toBe(405);
  });

  // --- CORS -------------------------------------------------------------------

  it('OPTIONS from allowed github.io origin returns 204 with CORS headers', async () => {
    const res = await worker.fetch(
      makeRequest({ method: 'OPTIONS', origin: 'https://gbarrett28.github.io' }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://gbarrett28.github.io');
  });

  it('OPTIONS from disallowed origin returns 403', async () => {
    const res = await worker.fetch(
      makeRequest({ method: 'OPTIONS', origin: 'https://evil.example.com' }),
      makeEnv({ ENVIRONMENT: 'production' }),
    );
    expect(res.status).toBe(403);
  });

  it('POST from disallowed origin in production returns 403', async () => {
    const res = await worker.fetch(
      makeRequest({ method: 'POST', origin: 'https://evil.example.com', contentType: 'application/json', body: validExport }),
      makeEnv({ ENVIRONMENT: 'production' }),
    );
    expect(res.status).toBe(403);
  });

  // --- Content-type -----------------------------------------------------------

  it('returns 400 for non-JSON content type', async () => {
    const res = await worker.fetch(
      makeRequest({ contentType: 'text/plain', body: 'hello' }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  // --- Body validation --------------------------------------------------------

  it('returns 400 for malformed JSON body', async () => {
    const req = new Request('https://worker.example.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{{{',
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 for JSON that fails TrainingExport schema', async () => {
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: { version: 99, samples: [] } }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  // --- R2 cap -----------------------------------------------------------------

  it('returns 429 when pending upload count is at the cap', async () => {
    const env = makeEnv({
      MAX_PENDING_UPLOADS: '2',
      TRAINING_BUCKET: {
        list: vi.fn().mockResolvedValue({ objects: [{}, {}] }),
        put: vi.fn(),
      } as unknown as R2Bucket,
    });
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validExport }),
      env,
    );
    expect(res.status).toBe(429);
  });

  // --- Happy path -------------------------------------------------------------

  it('stores payload in R2 and posts GitHub comment on valid upload', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validExport }),
      env,
    );
    expect(res.status).toBe(200);

    const bucket = env.TRAINING_BUCKET as unknown as { put: ReturnType<typeof vi.fn> };
    expect(bucket.put).toHaveBeenCalledOnce();
    const [key, body] = bucket.put.mock.calls[0] as [string, string, unknown];
    expect(key).toMatch(/^training\/2026-05-07T00:00:00\.000Z-[0-9a-f-]+\.json$/);
    expect(JSON.parse(body)).toMatchObject({ version: 1, sampleCount: 1 });

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(githubCall[0]).toContain('/issues/1/comments');
    expect(githubCall[1].headers).toMatchObject({ Authorization: 'Bearer fake-token' });
  });

  it('returns 200 even when GitHub API call fails, and logs the error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('GitHub down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const env = makeEnv();
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validExport }),
      env,
    );
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[training-worker]'),
      expect.any(Error),
    );
  });

  it('CORS headers present on 200 response', async () => {
    const res = await worker.fetch(
      makeRequest({
        contentType: 'application/json',
        body: validExport,
        origin: 'https://gbarrett28.github.io',
      }),
      makeEnv({ ENVIRONMENT: 'production' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://gbarrett28.github.io');
  });
});
