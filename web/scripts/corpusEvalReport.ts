/**
 * Pure aggregation logic for the corpus-evaluation tool (evaluate-corpus.ts).
 * Kept separate from the Playwright orchestration so it can be unit tested
 * without a browser or real puzzle images.
 */

export interface EvalRecord {
  readonly filename: string;
  readonly bucket: 'clean' | 'backtracked' | 'notSolved';
  readonly reason: string;
  readonly puzzleType: string | null;
  readonly detectedBigApple: boolean;
  readonly elapsedMs: number;
  readonly timestamp: string;
}

export interface CorpusEvalSummary {
  readonly total: number;
  readonly counts: { readonly clean: number; readonly backtracked: number; readonly notSolved: number };
  readonly percentages: { readonly clean: number; readonly backtracked: number; readonly notSolved: number };
  readonly notSolvedReasons: Readonly<Record<string, number>>;
}

/** Summarizes a list of per-image evaluation records into bucket counts, percentages, and a notSolved reason breakdown. */
export function aggregateReport(records: readonly EvalRecord[]): CorpusEvalSummary {
  const total = records.length;
  const counts = { clean: 0, backtracked: 0, notSolved: 0 };
  const notSolvedReasons: Record<string, number> = {};

  for (const r of records) {
    counts[r.bucket]++;
    if (r.bucket === 'notSolved') {
      notSolvedReasons[r.reason] = (notSolvedReasons[r.reason] ?? 0) + 1;
    }
  }

  const pct = (n: number): number => (total === 0 ? 0 : (n / total) * 100);

  return {
    total,
    counts,
    percentages: { clean: pct(counts.clean), backtracked: pct(counts.backtracked), notSolved: pct(counts.notSolved) },
    notSolvedReasons,
  };
}
