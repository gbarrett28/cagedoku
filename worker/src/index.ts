import { parseAnyReport, assertNeverReport } from '../../shared/src/reports/index.js';
import { TrainingExport } from '../../shared/src/reports/TrainingExport.js';
import { PuzzleSpecExport } from '../../shared/src/reports/PuzzleSpecExport.js';
import { StallStateExport } from '../../shared/src/reports/StallStateExport.js';
import { FeedbackReport } from '../../shared/src/reports/FeedbackReport.js';
import { RuleBugReport } from '../../shared/src/reports/RuleBugReport.js';
import { TriggerMissReport } from '../../shared/src/reports/TriggerMissReport.js';
import { CageThresholdCalibrationReport } from '../../shared/src/reports/CageThresholdCalibrationReport.js';

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
      return new Response(null, { status: 204, headers: corsHeaders(allowed) });
    }

    // GET /rule-fixtures/:ruleName — list R2 fixtures for the named rule.
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

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (allowed === null) return new Response('Forbidden', { status: 403 });

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

    const report = parseAnyReport(body);
    if (!report) {
      return new Response('Bad request: unrecognised schema', { status: 400, headers: corsHeaders(allowed) });
    }

    switch (report.reportType) {
      case 'training-export': {
        const maxPending = parseInt(env.MAX_PENDING_UPLOADS, 10);
        const listed = await env.TRAINING_BUCKET.list({ prefix: 'training/', limit: maxPending + 1 });
        if (listed.objects.length >= maxPending) {
          return new Response('Too many pending uploads — try again later', { status: 429, headers: corsHeaders(allowed) });
        }
        const key = TrainingExport.storageKey(report, crypto.randomUUID());
        await env.TRAINING_BUCKET.put(key, JSON.stringify(body), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: TrainingExport.r2Metadata(report),
        });
        const action = TrainingExport.githubAction(report, key);
        try { await postToGitHub(env, action.body); } catch (err) { console.error('[worker] GitHub comment failed:', err); }
        return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
      }

      case 'puzzle-spec': {
        const maxPending = parseInt(env.MAX_PENDING_UPLOADS, 10);
        const listed = await env.TRAINING_BUCKET.list({ prefix: 'puzzle-spec/', limit: maxPending + 1 });
        if (listed.objects.length >= maxPending) {
          return new Response('Too many pending uploads — try again later', { status: 429, headers: corsHeaders(allowed) });
        }
        const key = PuzzleSpecExport.storageKey(report, crypto.randomUUID());
        await env.TRAINING_BUCKET.put(key, JSON.stringify(body), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: PuzzleSpecExport.r2Metadata(report),
        });
        const action = PuzzleSpecExport.githubAction(report, key);
        try { await postToGitHub(env, action.body); } catch (err) { console.error('[worker] GitHub comment failed:', err); }
        return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
      }

      case 'stall': {
        const maxPending = parseInt(env.MAX_PENDING_UPLOADS, 10);
        const listed = await env.TRAINING_BUCKET.list({ prefix: 'stall/', limit: maxPending + 1 });
        if (listed.objects.length >= maxPending) {
          return new Response('Too many pending uploads — try again later', { status: 429, headers: corsHeaders(allowed) });
        }
        const key = StallStateExport.storageKey(report, crypto.randomUUID());
        await env.TRAINING_BUCKET.put(key, JSON.stringify(body), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: StallStateExport.r2Metadata(report),
        });
        const action = StallStateExport.githubAction(report, key);
        try { await postToGitHub(env, action.body); } catch (err) { console.error('[worker] GitHub comment failed:', err); }
        return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
      }

      case 'feedback': {
        const action = FeedbackReport.githubAction(report);
        try { await createGitHubIssue(env, action.title, action.body, action.labels); } catch (err) { console.error('[worker] GitHub issue creation failed:', err); }
        return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
      }

      case 'rule-bug': {
        const key = RuleBugReport.storageKey(report, crypto.randomUUID());
        await env.TRAINING_BUCKET.put(key, JSON.stringify(body), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: RuleBugReport.r2Metadata(report),
        });
        const fixture = RuleBugReport.toFixture(report);
        const fixtureKey = `rule-fixtures/${report.ruleName}/${new Date(report.reportedAt).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
        await env.TRAINING_BUCKET.put(fixtureKey, JSON.stringify(fixture), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: { ruleName: report.ruleName },
        });
        return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
      }

      case 'trigger-miss': {
        const key = TriggerMissReport.storageKey(report, crypto.randomUUID());
        await env.TRAINING_BUCKET.put(key, JSON.stringify(body), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: TriggerMissReport.r2Metadata(report),
        });
        const fixture = TriggerMissReport.toFixture(report);
        const fixtureKey = `rule-fixtures/${report.ruleName}/${new Date(report.reportedAt).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
        await env.TRAINING_BUCKET.put(fixtureKey, JSON.stringify(fixture), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: { ruleName: report.ruleName },
        });
        const action = TriggerMissReport.githubAction(report, key);
        try { await postToGitHub(env, action.body); } catch (err) { console.error('[worker] GitHub comment failed:', err); }
        return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
      }

      case 'cage-threshold-calibration': {
        const key = CageThresholdCalibrationReport.storageKey(report, crypto.randomUUID());
        await env.TRAINING_BUCKET.put(key, JSON.stringify(body), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: CageThresholdCalibrationReport.r2Metadata(report),
        });
        return new Response('OK', { status: 200, headers: corsHeaders(allowed) });
      }

      default:
        assertNeverReport(report);
    }
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

async function createGitHubIssue(env: Env, title: string, body: string, labels: readonly string[]): Promise<void> {
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
