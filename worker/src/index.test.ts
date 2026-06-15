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

const validFeedbackInaccurate = {
  ...validFeedback,
  bugCategory: 'inaccurate-description' as const,
};

const validFeedbackEnhancement = (() => {
  const { bugCategory: _b, expected: _e, ...rest } = validFeedback as typeof validFeedback & { expected?: string };
  return { ...rest, feedbackType: 'enhancement' as const, description: 'Add a dark mode toggle' };
})();

const validFeedbackNewRule = (() => {
  const { bugCategory: _b, expected: _e, ...rest } = validFeedback as typeof validFeedback & { expected?: string };
  return {
    ...rest,
    feedbackType: 'new-rule' as const,
    description: 'This puzzle needs a Skyscraper rule',
    fixtureName: 'TwoStringKite-1',
    unsolvedCells: 12,
    totalCandidates: 34,
  };
})();

function makeLargePuzzleSpec(turnCount: number): Record<string, unknown> {
  const candidates = Array.from({ length: 9 }, () =>
    Array.from({ length: 9 }, () => [1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const turns = Array.from({ length: turnCount }, (_, i) => ({
    action: { type: 'placeDigit', row: i % 9, col: (i * 3) % 9, digit: (i % 9) + 1, source: 'user' as const },
    autoMutations: [],
    snapshot: { candidates },
  }));
  const grid9x9 = Array.from({ length: 9 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) => ((r * 3 + Math.floor(r / 3) + c) % 9) + 1));
  const regions9x9 = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, () => r + 1));
  const cageTotals9x9 = Array.from({ length: 9 }, () => new Array<number>(9).fill(15));

  return {
    kind: 'killer',
    version: 1,
    specData: { regions: regions9x9, cageTotals: cageTotals9x9 },
    cageStates: [],
    userGrid: grid9x9,
    virtualCages: [],
    turns,
    alwaysApplyRules: [],
    goldenSolution: grid9x9,
    givenDigits: null,
    originalImageUrl: null,
    warpedImageUrl: null,
    userRemovedCandidates: [],
  };
}

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

  it('GET /rule-fixtures/:ruleName returns 200 with JSON array of {key, fixture}', async () => {
    const env = await makeEnv();
    await env.TRAINING_BUCKET.put('rule-fixtures/TwoStringKite/fix-1.json', JSON.stringify({ name: 'fix-1' }));

    const req = new Request('https://worker.example.com/rule-fixtures/TwoStringKite', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({ key: 'rule-fixtures/TwoStringKite/fix-1.json', fixture: { name: 'fix-1' } });
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

  it('stores the full feedback report to R2 under feedback/', async () => {
    const env = await makeEnv();
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body: validFeedback }),
      env,
    );
    expect(res.status).toBe(200);

    const listed = await env.TRAINING_BUCKET.list({ prefix: 'feedback/' });
    expect(listed.objects).toHaveLength(1);
    const stored = await env.TRAINING_BUCKET.get(listed.objects[0]!.key);
    const storedJson = await stored!.json();
    expect(storedJson).toMatchObject({ reportType: 'feedback', description: validFeedback.description });
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

  it.each<[string, Record<string, unknown>, string, string[]]>([
    ['bug / wrong-behaviour', validFeedback, '[Bug report]', ['feedback', 'bug']],
    ['bug / inaccurate-description', validFeedbackInaccurate, '[Bug report]', ['feedback', 'bug', 'documentation']],
    ['enhancement', validFeedbackEnhancement, '[Enhancement request]', ['feedback', 'enhancement']],
    ['new-rule', validFeedbackNewRule, '[Rule suggestion]', ['feedback', 'new-rule']],
  ])('creates a GitHub issue with the right title prefix and labels for %s', async (_label, body, titlePrefix, labels) => {
    const env = await makeEnv();
    const res = await worker.fetch(
      makeRequest({ contentType: 'application/json', body }),
      env,
    );
    expect(res.status).toBe(200);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(githubCall[0]).toMatch(/\/repos\/test\/repo\/issues$/);
    const issue = JSON.parse(githubCall[1].body as string) as { title: string; body: string; labels: string[] };
    expect(issue.title.startsWith(titlePrefix)).toBe(true);
    expect(issue.labels).toEqual(labels);
  });

  it('includes the expected-behaviour section for bug reports with `expected` set', async () => {
    const env = await makeEnv();
    await worker.fetch(makeRequest({ contentType: 'application/json', body: validFeedback }), env);

    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const issue = JSON.parse(githubCall[1].body as string) as { body: string };
    expect(issue.body).toContain('### Expected behaviour');
    expect(issue.body).toContain(validFeedback.expected);
  });

  it('includes the fixture section and fixture name in the title for new-rule reports', async () => {
    const env = await makeEnv();
    await worker.fetch(makeRequest({ contentType: 'application/json', body: validFeedbackNewRule }), env);

    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const issue = JSON.parse(githubCall[1].body as string) as { title: string; body: string };
    expect(issue.title).toContain('TwoStringKite-1');
    expect(issue.body).toContain('**Fixture:** `TwoStringKite-1`');
    expect(issue.body).toContain('**Unsolved cells:** 12');
    expect(issue.body).toContain('**Total candidates:** 34');
  });

  it('includes an Exception section when `exception` is set', async () => {
    const env = await makeEnv();
    const body = { ...validFeedback, exception: 'TypeError: something broke\n  at foo (bar.ts:1:1)' };
    await worker.fetch(makeRequest({ contentType: 'application/json', body }), env);

    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const issue = JSON.parse(githubCall[1].body as string) as { body: string };
    expect(issue.body).toContain('## Exception');
    expect(issue.body).toContain('TypeError: something broke');
  });

  it('handles a feedback report with a large, realistic puzzleSpec (full turn history) without error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { body: issueBody } = JSON.parse((init as RequestInit).body as string) as { body: string };
      if (issueBody.length > 65536) {
        return new Response('{"message":"Body is too long (maximum is 65536 characters)"}', { status: 422 });
      }
      return new Response('{}', { status: 201 });
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = await makeEnv();
    const body = { ...validFeedback, puzzleSpec: makeLargePuzzleSpec(25) };

    const res = await worker.fetch(makeRequest({ contentType: 'application/json', body }), env);

    expect(res.status).toBe(200);
    expect(consoleSpy).not.toHaveBeenCalled();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const githubCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const issue = JSON.parse(githubCall[1].body as string) as { body: string };
    expect(issue.body.length).toBeLessThanOrEqual(65536);
    expect(issue.body).toContain('<summary>Puzzle spec</summary>');
    expect(issue.body).toContain('"turns"');
    expect(issue.body).not.toContain('"snapshot"');

    // The full, untruncated report (with candidate snapshots) is still stored in R2.
    const listed = await env.TRAINING_BUCKET.list({ prefix: 'feedback/' });
    expect(listed.objects).toHaveLength(1);
    const stored = await env.TRAINING_BUCKET.get(listed.objects[0]!.key);
    const storedJson = await stored!.json() as { puzzleSpec: { turns: { snapshot?: unknown }[] } };
    expect(storedJson.puzzleSpec.turns[0]!.snapshot).toBeDefined();
  });
});

