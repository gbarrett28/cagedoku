import type { FeedbackReport } from '../../../shared/src/reports/FeedbackReport.js';

export type { FeedbackReport } from '../../../shared/src/reports/FeedbackReport.js';

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

export interface FeedbackPayloadParams {
  readonly feedbackType: 'bug' | 'enhancement' | 'new-rule';
  readonly bugCategory?: 'wrong-behaviour' | 'inaccurate-description';
  readonly description: string;
  readonly expected?: string;
  readonly actionLog: string;
  readonly puzzleSpec: unknown;
  readonly viewport: string;
  readonly config: { readonly alwaysApplyRules: readonly string[]; readonly autoPlacementDelay: number };
  readonly exception?: string;
  readonly fixtureContext?: { readonly name: string; readonly unsolvedCells: number; readonly totalCandidates: number };
  readonly appVersion: string;
  readonly userAgent: string;
}

/** Builds a `FeedbackReport` ready to POST to the training worker. */
export function buildFeedbackPayload(params: FeedbackPayloadParams): FeedbackReport {
  return {
    reportType: 'feedback',
    reportedAt: new Date().toISOString(),
    appVersion: params.appVersion,
    userAgent: params.userAgent,
    feedbackType: params.feedbackType,
    description: params.description,
    actionLog: params.actionLog,
    puzzleSpec: params.puzzleSpec,
    viewport: params.viewport,
    config: params.config,
    ...(params.bugCategory !== undefined && { bugCategory: params.bugCategory }),
    ...(params.expected !== undefined && { expected: params.expected }),
    ...(params.exception !== undefined && { exception: params.exception }),
    ...(params.fixtureContext !== undefined && {
      fixtureName: params.fixtureContext.name,
      unsolvedCells: params.fixtureContext.unsolvedCells,
      totalCandidates: params.fixtureContext.totalCandidates,
    }),
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export type FeedbackSubmitResult =
  | { readonly kind: 'logged' }
  | { readonly kind: 'success' }
  | { readonly kind: 'http-error'; readonly status: number; readonly body: string }
  | { readonly kind: 'network-error'; readonly message: string };

/** POSTs a feedback payload to the training worker. Falls back to logging to
 *  the console when no worker URL is configured (dev). */
export async function submitFeedback(payload: FeedbackReport): Promise<FeedbackSubmitResult> {
  const workerUrl = import.meta.env['VITE_TRAINING_WORKER_URL'] as string | undefined;
  if (!workerUrl) {
    console.log('[Feedback]', payload);
    return { kind: 'logged' };
  }

  try {
    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { kind: 'success' };
    const body = await res.text();
    return { kind: 'http-error', status: res.status, body };
  } catch (e) {
    return { kind: 'network-error', message: String(e) };
  }
}
