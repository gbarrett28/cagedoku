import { isTrainingExport, isPuzzleSpecExport, isFeedbackReport } from './validate.js';
import type { TrainingExport, PuzzleSpecExport, FeedbackReport } from './validate.js';

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

    if (isTrainingExport(body)) {
      const data: TrainingExport = body;
      const maxPending = parseInt(env.MAX_PENDING_UPLOADS, 10);
      const listed = await env.TRAINING_BUCKET.list({ prefix: 'training/', limit: maxPending + 1 });
      if (listed.objects.length >= maxPending) {
        return new Response('Too many pending uploads — try again later', { status: 429, headers: corsHeaders(allowed) });
      }
      const key = `training/${data.exportedAt}-${crypto.randomUUID()}.json`;
      await env.TRAINING_BUCKET.put(key, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { appVersion: data.appVersion, puzzleType: data.puzzleType, sampleCount: String(data.sampleCount) },
      });
      try { await postGitHubComment(env, data, key); } catch (err) { console.error('[training-worker] GitHub comment failed:', err); }
      return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
    }

    if (isPuzzleSpecExport(body)) {
      const data: PuzzleSpecExport = body;
      const maxPending = parseInt(env.MAX_PENDING_UPLOADS, 10);
      const listed = await env.TRAINING_BUCKET.list({ prefix: 'puzzle-spec/', limit: maxPending + 1 });
      if (listed.objects.length >= maxPending) {
        return new Response('Too many pending uploads — try again later', { status: 429, headers: corsHeaders(allowed) });
      }
      const key = `puzzle-spec/${data.exportedAt}-${crypto.randomUUID()}.json`;
      await env.TRAINING_BUCKET.put(key, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { appVersion: data.appVersion, puzzleType: data.puzzleType },
      });
      try { await postPuzzleSpecComment(env, data, key); } catch (err) { console.error('[training-worker] GitHub comment failed:', err); }
      return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
    }

    if (isFeedbackReport(body)) {
      const data: FeedbackReport = body;
      try { await createFeedbackIssue(env, data); } catch (err) { console.error('[training-worker] GitHub issue creation failed:', err); }
      return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
    }

    return new Response('Bad request: unrecognised schema', { status: 400, headers: corsHeaders(allowed) });
  },
};

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function postToGitHub(env: Env, commentBody: string): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${env.GITHUB_ISSUE_NUMBER}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'cagedoku-training-worker',
      },
      body: JSON.stringify({ body: commentBody }),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }
}

async function postGitHubComment(env: Env, data: TrainingExport, key: string): Promise<void> {
  await postToGitHub(
    env,
    `**New upload** — ${data.sampleCount} samples (${data.puzzleType}), ` +
    `app ${data.appVersion}, ${data.exportedAt}\n` +
    `R2 key: \`${key}\``,
  );
}

async function postPuzzleSpecComment(env: Env, data: PuzzleSpecExport, key: string): Promise<void> {
  await postToGitHub(
    env,
    `**Puzzle spec** — requires backtracking (${data.puzzleType}), ` +
    `app ${data.appVersion}, ${data.exportedAt}\n` +
    `R2 key: \`${key}\``,
  );
}

async function createFeedbackIssue(env: Env, data: FeedbackReport): Promise<void> {
  const typeLabel = data.feedbackType === 'bug' ? 'Bug report' : 'Enhancement request';
  const titleSnippet = data.description.slice(0, 72).replace(/[\r\n]+/g, ' ');
  const title = `[${typeLabel}] ${titleSnippet}${data.description.length > 72 ? '…' : ''}`;

  const labels = ['feedback', data.feedbackType === 'bug' ? 'bug' : 'enhancement'];
  if (data.bugCategory === 'inaccurate-description') labels.push('documentation');

  const config = data.config as { alwaysApplyRules?: unknown; autoPlacementDelay?: unknown };
  const rules = Array.isArray(config.alwaysApplyRules) ? (config.alwaysApplyRules as string[]).join(', ') || '(none)' : '?';
  const delay = typeof config.autoPlacementDelay === 'number' ? `${config.autoPlacementDelay}ms` : '?';

  const bugCatLine = data.feedbackType === 'bug' && data.bugCategory
    ? `**Category:** ${data.bugCategory === 'wrong-behaviour' ? 'Wrong behaviour' : 'Inaccurate description/documentation'}\n`
    : '';

  const expectedSection = data.expected
    ? `\n### Expected behaviour\n${data.expected}\n`
    : '';

  const specJson = data.puzzleSpec !== null
    ? `\n<details>\n<summary>Puzzle spec</summary>\n\n\`\`\`json\n${JSON.stringify(data.puzzleSpec, null, 2)}\n\`\`\`\n\n</details>\n`
    : '';

  const body = `## ${typeLabel}

**Reported:** ${data.reportedAt}
**App version:** ${data.appVersion}
**Browser:** ${data.userAgent}
**Viewport:** ${data.viewport}
${bugCatLine}
### Description
${data.description}
${expectedSection}
### Config
- Auto-apply rules: ${rules}
- Step delay: ${delay}
${specJson}
### Session trace

<details>
<summary>${data.actionLog.split('\n').length} events</summary>

\`\`\`
${data.actionLog}
\`\`\`

</details>
`;

  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/issues`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'cagedoku-training-worker',
      },
      body: JSON.stringify({ title, body, labels }),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }
}
