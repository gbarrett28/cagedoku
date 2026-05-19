export interface AssertionContext {
  name: string;
  description: string;
  puzzleSpecJson: string;
  solutionJson: string;
  actionLog: string;
}

export class AssertionViolation extends Error {
  readonly ctx: AssertionContext;
  constructor(ctx: AssertionContext) {
    super(`[Assertion] ${ctx.name}: ${ctx.description}`);
    this.ctx = ctx;
  }
}

/**
 * Validates a 9×9 sudoku solution grid.
 * Returns null if valid, or a human-readable description of the first problem found.
 */
export function validateSudokuSolution(solution: number[][]): string | null {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if ((solution[r]![c] ?? 0) === 0) return `Cell r${r + 1}c${c + 1} is unsolved (0)`;
    }
  }
  for (let r = 0; r < 9; r++) {
    const seen = new Set<number>();
    for (let c = 0; c < 9; c++) {
      const d = solution[r]![c]!;
      if (seen.has(d)) return `Row ${r + 1} has duplicate digit ${d}`;
      seen.add(d);
    }
  }
  for (let c = 0; c < 9; c++) {
    const seen = new Set<number>();
    for (let r = 0; r < 9; r++) {
      const d = solution[r]![c]!;
      if (seen.has(d)) return `Col ${c + 1} has duplicate digit ${d}`;
      seen.add(d);
    }
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const seen = new Set<number>();
      for (let dr = 0; dr < 3; dr++) {
        for (let dc = 0; dc < 3; dc++) {
          const d = solution[br * 3 + dr]![bc * 3 + dc]!;
          if (seen.has(d)) return `Box (${br + 1},${bc + 1}) has duplicate digit ${d}`;
          seen.add(d);
        }
      }
    }
  }
  return null;
}

/** Builds a pre-filled GitHub new-issue URL for the given assertion violation. */
export function buildGitHubIssueUrl(ctx: AssertionContext): string {
  const title = encodeURIComponent(`[Assertion] ${ctx.name}`);
  const body = encodeURIComponent(
    `**Anomaly:** ${ctx.description}\n\n` +
    `**Puzzle spec:**\n\`\`\`json\n${ctx.puzzleSpecJson}\n\`\`\`\n\n` +
    `**Solution:**\n\`\`\`json\n${ctx.solutionJson}\n\`\`\`\n\n` +
    `**Action log:**\n\`\`\`\n${ctx.actionLog}\n\`\`\``,
  );
  return `https://github.com/gbarrett28/cagedoku/issues/new?title=${title}&body=${body}`;
}
