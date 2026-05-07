import { isTrainingExport } from './validate.js';
import type { TrainingExport } from './validate.js';

export interface Env {
  TRAINING_BUCKET: R2Bucket;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  GITHUB_ISSUE_NUMBER: string;
  MAX_PENDING_UPLOADS: string;
  ENVIRONMENT: string;
}

const ALLOWED_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.github\.io$/;

function allowedOrigin(origin: string | null, env: Env): string | null {
  if (env.ENVIRONMENT === 'development') return origin ?? '*';
  if (origin !== null && ALLOWED_ORIGIN_RE.test(origin)) return origin;
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = allowedOrigin(origin, env);

    if (request.method === 'OPTIONS') {
      if (allowed === null) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowed),
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (allowed === null) {
      return new Response('Forbidden', { status: 403 });
    }

    const ct = request.headers.get('Content-Type') ?? '';
    if (!ct.includes('application/json')) {
      return new Response('Bad request: expected application/json', { status: 400, headers: corsHeaders(allowed) });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad request: invalid JSON', { status: 400, headers: corsHeaders(allowed) });
    }

    if (!isTrainingExport(body)) {
      return new Response('Bad request: invalid TrainingExport schema', { status: 400, headers: corsHeaders(allowed) });
    }

    const data: TrainingExport = body;
    const maxPending = parseInt(env.MAX_PENDING_UPLOADS, 10);

    const listed = await env.TRAINING_BUCKET.list({ prefix: 'training/', limit: maxPending + 1 });
    if (listed.objects.length >= maxPending) {
      return new Response('Too many pending uploads — try again later', { status: 429, headers: corsHeaders(allowed) });
    }

    const key = `training/${data.exportedAt}-${crypto.randomUUID()}.json`;
    await env.TRAINING_BUCKET.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        appVersion: data.appVersion,
        puzzleType: data.puzzleType,
        sampleCount: String(data.sampleCount),
      },
    });

    // Data is safely stored — attempt GitHub notification but don't fail the
    // response if the Issues API is unavailable.
    try {
      await postGitHubComment(env, data, key);
    } catch (err) {
      console.error('[training-worker] GitHub comment failed:', err);
    }

    return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
  },
};

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function postGitHubComment(env: Env, data: TrainingExport, key: string): Promise<void> {
  const body =
    `**New upload** — ${data.sampleCount} samples (${data.puzzleType}), ` +
    `app ${data.appVersion}, ${data.exportedAt}\n` +
    `R2 key: \`${key}\``;

  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${env.GITHUB_ISSUE_NUMBER}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'cagedoku-training-worker',
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }
}
