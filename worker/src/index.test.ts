import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Miniflare } from 'miniflare';
import worker from './index.js';
import type { Env } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mf: Miniflare;

function makeEnv(overrides: Partial<Env> = {}): Promise<Env> {
  return mf.getR2Bucket('TRAINING_BUCKET').then((bucket) => ({
    TRAINING_BUCKET: bucket,
    GITHUB_TOKEN: 'fake-token',
    GITHUB_REPO: 'test/repo',
    GITHUB_ISSUE_NUMBER: '1',
    MAX_PENDING_UPLOADS: '50',
    ENVIRONMENT: 'development',
    ...overrides,
  }));
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
  reportType: 'training-export' as const,
  exportedAt: '2026-05-07T00:00:00.000Z',
  appVersion: 'test',
  puzzleType: 'killer',
  subres: 128,
  thumbnailSize: 64,
  sampleCount: 1,
  samples: [{ digit: 3, pixels: new Array<number>(4096).fill(128) }],
};

const validStallState = {
  reportType: 'stall' as const,
  reportedAt: '2026-05-21T10:00:00.000Z',
  appVersion: '2026-05-21 09:00',
  userAgent: 'Mozilla/5.0 test',
  puzzleType: 'classic' as const,
  stalledCandidates: Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => [1, 2, 3])),
};

const validFeedback = {
  reportType: 'feedback' as const,
  reportedAt: '2026-05-16T12:00:00.000Z',
  appVersion: '2026-05-16 10:00',
  feedbackType: 'bug' as const,
  bugCategory: 'wrong-behaviour' as const,
  description: 'The hint was incorrect',
  expected: 'The hint should say X',
  actionLog: 'load\nhint',
  puzzleSpec: null,
  userAgent: 'Mozilla/5.0',
  viewport: '1280×720',
  config: { alwaysApplyRules: [] as string[], autoPlacementDelay: 500 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Worker fetch handler', () => {
  beforeEach(() => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("unused"); } };',
      r2Buckets: ['TRAINING_BUCKET'],
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 201 }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await mf.dispose();
  });

  // --- Method -----------------------------------------------------------------

  it('returns 404 for GET requests to an unknown path', async () => {
    const res = await worker.fetch(makeRequest({ method: 'GET' }), await makeEnv());
    expect(res.status).toBe(404);
  });

  it('GET /rule-fixtures/:ruleName returns 200 with JSON array', async () => {
    const env = await makeEnv();
    await env.TRAINING_BUCKET.put('rule-fixtures/TwoStringKite/fix-1.json', JSON.stringify({ name: 'fix-1' }));

    const req = new Request('https://worker.example.com/rule-fixtures/TwoStringKite', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({ name: 'fix-1' });
  });

  // --- CORS -------------------------------------------------------------------

  it('OPTIONS from allowed github.io origin returns 204 with CORS headers', async () => {
    const res = await worker.fetch(
      makeRequest({ method: 'OPTIONS', origin: 'https://gbarrett28.github.io' }),
      await makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://gbarrett28.github.io');
  });

  it('OPTIONS from disallowed origin returns 403', async () => {
    const res = await worker.fetch(
      makeRequest({ method: 'OPTIONS', origin: 'https://evil.example.com' }),
      await makeEnv({ ENVIRONMENT: 'production' }),
    );
    expect(res.status).toBe(403);
  });

  it('POST from disallowed origin in production returns 403', async () => {
    const res = await worker.fetch(
      makeRequest({ method: 'POST', origin: 'https://evil.example.com', contentType: 'application/json', body: validExport }),
      await makeEnv({ ENVIRONMENT: 'production' }),
    );
    expect(res.status).toBe(403);
  });

  // --- Content-type -----------------------------------------------------------

  it('returns 400 for non-JSON content type', async () => {
    const res = await worker.fetch(
      makeRequest({ contentType: 'text/plain', body: 'hello' }),
      await makeEnv(),
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
    const res = await worker.fetch(req, await makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 for JSON that fails TrainingExport schema', async () => {
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: { version: 99, samples: [] } }),
      await makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  // --- R2 cap -----------------------------------------------------------------

  it('returns 429 when pending upload count is at the cap', async () => {
    const env = await makeEnv({ MAX_PENDING_UPLOADS: '2' });
    await env.TRAINING_BUCKET.put('training/existing-1.json', 'x');
    await env.TRAINING_BUCKET.put('training/existing-2.json', 'x');

    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validExport }),
      env,
    );
    expect(res.status).toBe(429);
  });

  // --- Happy path -------------------------------------------------------------

  it('stores payload in R2 and posts GitHub comment on valid upload', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validExport }),
      env,
    );
    expect(res.status).toBe(200);

    const listed = await env.TRAINING_BUCKET.list({ prefix: 'training/' });
    expect(listed.objects).toHaveLength(1);
    const key = listed.objects[0]!.key;
    expect(key).toMatch(/^training\/2026-05-07T00:00:00\.000Z-[0-9a-f-]+\.json$/);
    const obj = await env.TRAINING_BUCKET.get(key);
    const body = JSON.parse(await obj!.text()) as Record<string, unknown>;
    expect(body).toMatchObject({ reportType: 'training-export', sampleCount: 1 });

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(githubCall[0]).toContain('/issues/1/comments');
    expect(githubCall[1].headers).toMatchObject({ Authorization: 'Bearer fake-token' });
  });

  it('returns 200 even when GitHub API call fails, and logs the error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('GitHub down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const env = await makeEnv();
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validExport }),
      env,
    );
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[worker]'),
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
      await makeEnv({ ENVIRONMENT: 'production' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://gbarrett28.github.io');
  });

  // --- Stall state path -------------------------------------------------------

  it('stores stall state in R2 and posts GitHub comment', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validStallState }),
      env,
    );
    expect(res.status).toBe(200);

    const listed = await env.TRAINING_BUCKET.list({ prefix: 'stall/' });
    expect(listed.objects).toHaveLength(1);
    const key = listed.objects[0]!.key;
    expect(key).toMatch(/^stall\/2026-05-21T10:00:00\.000Z-[0-9a-f-]+\.json$/);
    const obj = await env.TRAINING_BUCKET.get(key);
    const body = JSON.parse(await obj!.text()) as Record<string, unknown>;
    expect(body).toMatchObject({ reportType: 'stall', puzzleType: 'classic' });

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(githubCall[0]).toContain('/issues/1/comments');
    const commentBody = JSON.parse(githubCall[1].body as string) as { body: string };
    expect(commentBody.body).toContain('Stall state');
    expect(commentBody.body).toContain('stall/');
  });

  it('returns 200 even when GitHub comment fails for stall state', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('GitHub down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validStallState }),
      await makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[worker]'),
      expect.any(Error),
    );
  });

  // --- Feedback path ----------------------------------------------------------

  it('creates GitHub issue on valid feedback report', async () => {
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validFeedback }),
      await makeEnv(),
    );
    expect(res.status).toBe(200);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(githubCall[0]).toMatch(/\/repos\/test\/repo\/issues$/);
    expect(githubCall[1].headers).toMatchObject({ Authorization: 'Bearer fake-token' });
  });

  it('returns 200 even when GitHub issue creation fails, and logs the error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('GitHub down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validFeedback }),
      await makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[worker]'),
      expect.any(Error),
    );
  });
});

