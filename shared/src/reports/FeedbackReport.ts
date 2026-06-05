import type { GitHubAction, ReportBase } from '../report.js';

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

  /** FeedbackReport is not stored in R2 — it opens a GitHub issue instead. */
  export function storageKey(_r: FeedbackReport, _uuid: string): null {
    return null;
  }

  export function githubAction(r: FeedbackReport): { kind: 'issue'; title: string; body: string; labels: string[] } {
    return { kind: 'issue', ...buildIssue(r) };
  }

  function buildIssue(r: FeedbackReport): { title: string; body: string; labels: string[] } {
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
      ? `\n<details>\n<summary>Puzzle spec</summary>\n\n\`\`\`json\n${JSON.stringify(r.puzzleSpec, null, 2)}\n\`\`\`\n\n</details>\n`
      : '';
    const fixtureSection = isNewRule && r.fixtureName
      ? `**Fixture:** \`${r.fixtureName}\`\n` +
        `**Unsolved cells:** ${r.unsolvedCells ?? '?'}\n` +
        `**Total candidates:** ${r.totalCandidates ?? '?'}\n\n`
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
${specJson}
### Session trace

<details>
<summary>${r.actionLog.split('\n').length} events</summary>

\`\`\`
${r.actionLog}
\`\`\`

</details>
`;
    return { title, body, labels };
  }
}
