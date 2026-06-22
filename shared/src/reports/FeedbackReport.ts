import type { ReportBase } from '../report.js';

export interface FeedbackReport extends ReportBase {
  readonly reportType: 'feedback';
  readonly feedbackType: 'bug' | 'enhancement' | 'new-rule';
  readonly bugCategory?: 'wrong-behaviour' | 'inaccurate-description';
  readonly description: string;
  readonly expected?: string;
  readonly actionLog: string;
  readonly puzzleSpec: unknown;
  readonly viewport: string;
  readonly config: { readonly alwaysApplyRules: readonly string[]; readonly autoPlacementDelay: number };
  readonly exception?: string;
  readonly fixtureName?: string;
  readonly unsolvedCells?: number;
  readonly totalCandidates?: number;
  readonly activeHint?: unknown;
}

export namespace FeedbackReport {
  export function is(value: unknown): value is FeedbackReport {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (v['reportType'] !== 'feedback') return false;
    if (typeof v['reportedAt'] !== 'string') return false;
    if (typeof v['appVersion'] !== 'string') return false;
    if (typeof v['userAgent'] !== 'string') return false;
    if (v['feedbackType'] !== 'bug' && v['feedbackType'] !== 'enhancement' && v['feedbackType'] !== 'new-rule') return false;
    if (v['feedbackType'] === 'bug' && v['bugCategory'] !== undefined &&
        v['bugCategory'] !== 'wrong-behaviour' && v['bugCategory'] !== 'inaccurate-description') return false;
    if (typeof v['description'] !== 'string') return false;
    if (v['expected'] !== undefined && typeof v['expected'] !== 'string') return false;
    if (typeof v['actionLog'] !== 'string') return false;
    if (typeof v['viewport'] !== 'string') return false;
    if (typeof v['config'] !== 'object' || v['config'] === null) return false;
    if ('exception' in v && typeof v['exception'] !== 'string') return false;
    if (v['fixtureName'] !== undefined && typeof v['fixtureName'] !== 'string') return false;
    if (v['unsolvedCells'] !== undefined && typeof v['unsolvedCells'] !== 'number') return false;
    if (v['totalCandidates'] !== undefined && typeof v['totalCandidates'] !== 'number') return false;
    return true;
  }

  export function storageKey(r: FeedbackReport, uuid: string): string {
    const timestamp = r.reportedAt.replace(/[:.]/g, '-');
    return `feedback/${timestamp}-${uuid}.json`;
  }

  export function r2Metadata(r: FeedbackReport): Record<string, string> {
    return { appVersion: r.appVersion, feedbackType: r.feedbackType };
  }

  /** Opens a GitHub issue. `key` is the R2 object holding the full (untruncated) report. */
  export function githubAction(r: FeedbackReport, key: string): { kind: 'issue'; title: string; body: string; labels: string[] } {
    return { kind: 'issue', ...buildIssue(r, key) };
  }

  function buildIssue(r: FeedbackReport, key: string): { title: string; body: string; labels: string[] } {
    const isNewRule = r.feedbackType === 'new-rule';
    const typeLabel = r.feedbackType === 'bug'
      ? 'Bug report'
      : isNewRule ? 'Rule suggestion' : 'Enhancement request';

    const snippet = r.description.slice(0, 72).replace(/[\r\n]+/g, ' ');
    const ellipsis = r.description.length > 72 ? '…' : '';
    const title = isNewRule && r.fixtureName
      ? `[${typeLabel}] ${r.fixtureName}: ${snippet}${ellipsis}`
      : `[${typeLabel}] ${snippet}${ellipsis}`;

    const labels: string[] = isNewRule
      ? ['feedback', 'new-rule']
      : ['feedback', r.feedbackType === 'bug' ? 'bug' : 'enhancement'];
    if (r.bugCategory === 'inaccurate-description') labels.push('documentation');

    const cfg = r.config as { alwaysApplyRules?: unknown; autoPlacementDelay?: unknown };
    const rules = Array.isArray(cfg.alwaysApplyRules) ? (cfg.alwaysApplyRules as string[]).join(', ') || '(none)' : '?';
    const delay = typeof cfg.autoPlacementDelay === 'number' ? `${cfg.autoPlacementDelay}ms` : '?';
    const bugCatLine = r.feedbackType === 'bug' && r.bugCategory
      ? `**Category:** ${r.bugCategory === 'wrong-behaviour' ? 'Wrong behaviour' : 'Inaccurate description/documentation'}\n`
      : '';
    const expectedSection = r.expected ? `\n### Expected behaviour\n${r.expected}\n` : '';
    const exceptionSection = r.exception ? `\n## Exception\n\`\`\`\n${r.exception}\n\`\`\`\n` : '';
    const specJson = r.puzzleSpec !== null
      ? `\n<details>\n<summary>Puzzle spec</summary>\n\n\`\`\`json\n${JSON.stringify(stripSnapshots(r.puzzleSpec), null, 2)}\n\`\`\`\n\n</details>\n`
      : '';
    const fixtureSection = isNewRule && r.fixtureName
      ? `**Fixture:** \`${r.fixtureName}\`\n` +
        `**Unsolved cells:** ${r.unsolvedCells ?? '?'}\n` +
        `**Total candidates:** ${r.totalCandidates ?? '?'}\n\n`
      : '';
    const activeHintSection = r.activeHint !== undefined
      ? `\n<details>\n<summary>Active hint</summary>\n\n\`\`\`json\n${JSON.stringify(r.activeHint, null, 2)}\n\`\`\`\n\n</details>\n`
      : '';

    const body = `## ${typeLabel}

${fixtureSection}**Reported:** ${r.reportedAt}
**App version:** ${r.appVersion}
**Browser:** ${r.userAgent}
**Viewport:** ${r.viewport}
${bugCatLine}
### Description
${r.description}
${expectedSection}${exceptionSection}
### Config
- Auto-apply rules: ${rules}
- Step delay: ${delay}
${specJson}${activeHintSection}
**Full report (with candidate snapshots):** R2 key \`${key}\`

### Session trace

<details>
<summary>${r.actionLog.split('\n').length} events</summary>

\`\`\`
${r.actionLog}
\`\`\`

</details>
`;
    return { title, body: truncateBody(body, key), labels };
  }

  /**
   * Strips per-turn `BoardSnapshot.candidates` arrays from a serialized
   * `PuzzleState` — they're a rendering cache, not needed to replay the
   * session via `PuzzleState.deserialize` + `buildEngine`, and they dominate
   * the size of the issue body for sessions with many turns.
   */
  function stripSnapshots(puzzleSpec: unknown): unknown {
    if (typeof puzzleSpec !== 'object' || puzzleSpec === null) return puzzleSpec;
    const v = puzzleSpec as Record<string, unknown>;
    if (!Array.isArray(v['turns'])) return puzzleSpec;
    return {
      ...v,
      turns: v['turns'].map((turn: unknown) => {
        if (typeof turn !== 'object' || turn === null) return turn;
        const { snapshot: _snapshot, ...rest } = turn as Record<string, unknown>;
        return rest;
      }),
    };
  }

  /** GitHub caps issue bodies at 65536 characters; truncate with a pointer to the full R2 report. */
  const MAX_BODY_LENGTH = 65536;

  function truncateBody(body: string, key: string): string {
    if (body.length <= MAX_BODY_LENGTH) return body;
    const notice = `\n\n*(Issue body truncated — see R2 key \`${key}\` for the full report.)*\n`;
    return body.slice(0, MAX_BODY_LENGTH - notice.length) + notice;
  }
}
