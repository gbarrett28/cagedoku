import { isTrainingExport, isPuzzleSpecExport, isStallStateExport, isFeedbackReport, isRuleBugReport, isTriggerMissReport } from './validate.js';
import type { TrainingExport, PuzzleSpecExport, StallStateExport, FeedbackReport, RuleBugReport, TriggerMissReport } from './validate.js';

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

    // GET /rule-fixtures/:ruleName — list R2 fixtures for the named rule.
    // Used by the rule-regression GitHub Action (server-to-server, no browser origin).
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/rule-fixtures\/([A-Za-z0-9_-]+)$/);
      if (!match) return new Response('Not found', { status: 404 });
      const ruleName = match[1]!;
      const listed = await env.TRAINING_BUCKET.list({ prefix: `rule-fixtures/${ruleName}/` });
      const fixtures: unknown[] = [];
      for (const obj of listed.objects) {
        const r2obj = await env.TRAINING_BUCKET.get(obj.key);
        if (r2obj) fixtures.push(await r2obj.json());
      }
      return new Response(JSON.stringify(fixtures), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
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

    if (isStallStateExport(body)) {
      const data: StallStateExport = body;
      const maxPending = parseInt(env.MAX_PENDING_UPLOADS, 10);
      const listed = await env.TRAINING_BUCKET.list({ prefix: 'stall/', limit: maxPending + 1 });
      if (listed.objects.length >= maxPending) {
        return new Response('Too many pending uploads — try again later', { status: 429, headers: corsHeaders(allowed) });
      }
      const key = `stall/${data.exportedAt}-${crypto.randomUUID()}.json`;
      await env.TRAINING_BUCKET.put(key, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { appVersion: data.appVersion, puzzleType: data.puzzleType },
      });
      try { await postStallComment(env, data, key); } catch (err) { console.error('[training-worker] GitHub comment failed:', err); }
      return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
    }

    if (isFeedbackReport(body)) {
      const data: FeedbackReport = body;
      try { await createFeedbackIssue(env, data); } catch (err) { console.error('[training-worker] GitHub issue creation failed:', err); }
      return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
    }

    if (isRuleBugReport(body)) {
      const data: RuleBugReport = body;
      const timestamp = new Date(data.reportedAt).toISOString().replace(/[:.]/g, '-');
      const rawKey = `rule-bugs/${data.ruleName}/${timestamp}-${crypto.randomUUID()}.json`;
      await env.TRAINING_BUCKET.put(rawKey, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { appVersion: data.appVersion, ruleName: data.ruleName },
      });
      const unsolvedCells = data.stalledCandidates.flat().filter(cell => cell.length > 1).length;
      const totalCandidates = data.stalledCandidates.flat().reduce((s, cell) => s + cell.length, 0);
      const fixtureName = `${data.ruleName}-r2-${timestamp}`;
      const fixture = {
        version: 1,
        source: 'r2',
        name: fixtureName,
        addedAt: data.reportedAt.slice(0, 10),
        puzzleType: data.puzzleType,
        ruleName: data.ruleName,
        regions: data.regions,
        cageTotals: data.cageTotals,
        stalledCandidates: data.stalledCandidates,
        goldenSolution: data.goldenSolution,
        unsolvedCells,
        totalCandidates,
      };
      const fixtureKey = `rule-fixtures/${data.ruleName}/${timestamp}-${crypto.randomUUID()}.json`;
      await env.TRAINING_BUCKET.put(fixtureKey, JSON.stringify(fixture), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { ruleName: data.ruleName },
      });
      return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
    }

    if (isTriggerMissReport(body)) {
      const data: TriggerMissReport = body;
      const timestamp = new Date(data.reportedAt).toISOString().replace(/[:.]/g, '-');
      const key = `trigger-misses/${data.ruleName}/${timestamp}-${crypto.randomUUID()}.json`;
      await env.TRAINING_BUCKET.put(key, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { appVersion: data.appVersion, ruleName: data.ruleName, missedContext: data.missedContext },
      });
      // Also write a rule-fixtures entry so the nightly regression action picks it up.
      const unsolvedCells = data.stalledCandidates.flat().filter(cell => cell.length > 1).length;
      const totalCandidates = data.stalledCandidates.flat().reduce((s, cell) => s + cell.length, 0);
      const fixtureName = `${data.ruleName}-trigger-miss-${timestamp}`;
      const fixture = {
        version: 1,
        source: 'trigger-miss',
        name: fixtureName,
        addedAt: data.reportedAt.slice(0, 10),
        puzzleType: data.puzzleType,
        ruleName: data.ruleName,
        regions: data.regions,
        cageTotals: data.cageTotals,
        stalledCandidates: data.stalledCandidates,
        goldenSolution: data.goldenSolution,
        missedContext: data.missedContext,
        missedEliminations: data.missedEliminations,
        unsolvedCells,
        totalCandidates,
      };
      const fixtureKey = `rule-fixtures/${data.ruleName}/${timestamp}-${crypto.randomUUID()}.json`;
      await env.TRAINING_BUCKET.put(fixtureKey, JSON.stringify(fixture), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { ruleName: data.ruleName },
      });
      try { await postTriggerMissComment(env, data, key); } catch (err) { console.error('[training-worker] GitHub comment failed:', err); }
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

async function postTriggerMissComment(env: Env, data: TriggerMissReport, key: string): Promise<void> {
  const elimSummary = data.missedEliminations.slice(0, 5)
    .map(e => `r${e.cell[0] + 1}c${e.cell[1] + 1}≠${e.digit}`)
    .join(', ');
  const more = data.missedEliminations.length > 5 ? ` (+${data.missedEliminations.length - 5} more)` : '';
  await postToGitHub(
    env,
    `**Trigger miss** — rule \`${data.ruleName}\`, context \`${data.missedContext}\` (${data.puzzleType})\n` +
    `Missed eliminations: ${elimSummary}${more}\n` +
    `App ${data.appVersion}\nR2 key: \`${key}\``,
  );
}

async function postStallComment(env: Env, data: StallStateExport, key: string): Promise<void> {
  const solved = data.stalledCandidates.flat().filter(c => c.length === 1).length;
  await postToGitHub(
    env,
    `**Stall state** — ${solved}/81 cells solved at stall (${data.puzzleType}), ` +
    `app ${data.appVersion}, ${data.exportedAt}\n` +
    `R2 key: \`${key}\``,
  );
}

async function createFeedbackIssue(env: Env, data: FeedbackReport): Promise<void> {
  const isNewRule = data.feedbackType === 'new-rule';
  const typeLabel = data.feedbackType === 'bug'
    ? 'Bug report'
    : isNewRule ? 'Rule suggestion' : 'Enhancement request';

  const snippet = data.description.slice(0, 72).replace(/[\r\n]+/g, ' ');
  const ellipsis = data.description.length > 72 ? '…' : '';
  const title = isNewRule && data.fixtureName
    ? `[${typeLabel}] ${data.fixtureName}: ${snippet}${ellipsis}`
    : `[${typeLabel}] ${snippet}${ellipsis}`;

  const labels = isNewRule
    ? ['feedback', 'new-rule']
    : ['feedback', data.feedbackType === 'bug' ? 'bug' : 'enhancement'];
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

  const exceptionSection = data.exception
    ? `\n## Exception\n\`\`\`\n${data.exception}\n\`\`\`\n`
    : '';

  const specJson = data.puzzleSpec !== null
    ? `\n<details>\n<summary>Puzzle spec</summary>\n\n\`\`\`json\n${JSON.stringify(data.puzzleSpec, null, 2)}\n\`\`\`\n\n</details>\n`
    : '';

  // Fixture reference block — prepended for rule suggestions when a fixture is active.
  const fixtureSection = isNewRule && data.fixtureName
    ? `**Fixture:** \`${data.fixtureName}\`\n` +
      `**Unsolved cells:** ${data.unsolvedCells ?? '?'}\n` +
      `**Total candidates:** ${data.totalCandidates ?? '?'}\n\n`
    : '';

  const body = `## ${typeLabel}

${fixtureSection}**Reported:** ${data.reportedAt}
**App version:** ${data.appVersion}
**Browser:** ${data.userAgent}
**Viewport:** ${data.viewport}
${bugCatLine}
### Description
${data.description}
${expectedSection}${exceptionSection}
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
