# Hard Puzzles Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the stall fixture corpus as a public "Hard Puzzles" panel accessible via a flame header button, with rule-suggestion feedback routed through the existing Cloudflare Worker pipeline.

**Architecture:** Three independent sub-projects: (1) Vite plugin emits fixtures as static assets so they are available in production builds; (2) a flame toggle in the header swaps `#upload-panel` for a `#fixture-panel` table; (3) a third radio option in the feedback modal sends rule-suggestion reports through the existing worker -> GitHub Issues pipeline with a `new-rule` label.

**Tech Stack:** TypeScript, Vite (Rollup plugin API `this.emitFile`), Vitest, Playwright, Cloudflare Workers (Wrangler).

---

## File map

| File | What changes |
|---|---|
| `web/vite.config.ts` | Drop `apply: 'serve'`; add `generateBundle` hook; update middleware URL scheme |
| `web/src/main.ts` | Update fetch URLs; add fixture state vars; replace old dev panel block with toggle + fixture loading; update feedback handler |
| `web/index.html` | Add flame button to header; add `#fixture-panel` section; add `feedback-type-new-rule` radio |
| `web/public/styles.css` | Add `.fixture-table` and `.fixture-intro` styles |
| `web/e2e/flow.spec.ts` | Add flame toggle smoke test |
| `worker/src/validate.ts` | Expand `FeedbackReport` type and `isFeedbackReport` validator |
| `worker/src/validate.test.ts` | Tests for new feedback type and optional fields |
| `worker/src/index.ts` | Handle `'new-rule'` in `createFeedbackIssue` |

---

## Task 1: Vite plugin — static serving

**Files:**
- Modify: `web/vite.config.ts`
- Modify: `web/src/main.ts` (fetch URL strings only)

- [ ] **Step 1: Replace the stallFixturesPlugin in `web/vite.config.ts`**

Replace the entire `stallFixturesPlugin` constant (from `const stallFixturesPlugin` through the closing `};`) with:

```ts
const stallFixturesPlugin: Plugin = {
  name: 'stall-fixtures',
  // No apply: 'serve' — configureServer runs in serve mode only anyway;
  // generateBundle runs only in build mode. Both modes are needed.
  configureServer(server) {
    const fixturesDir = path.resolve(import.meta.dirname, 'stall-fixtures');

    server.middlewares.use('/stall-fixtures', (req, res) => {
      const url = req.url ?? '/';
      const segment = url.replace(/^\//, '').split('?')[0] ?? '';

      if (segment === 'index.json') {
        // Metadata list — omit spec and stalledCandidates
        try {
          const files = fs
            .readdirSync(fixturesDir)
            .filter((f) => f.endsWith('.stall.json'));

          const metadata = files
            .map((f) => {
              const fixture = JSON.parse(
                fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
              ) as StallFixtureFile;
              const { spec: _spec, stalledCandidates: _sc, ...meta } = fixture;
              return meta;
            })
            .sort(
              (a, b) =>
                a.unsolvedCells - b.unsolvedCells ||
                a.totalCandidates - b.totalCandidates,
            );

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(metadata));
        } catch {
          res.statusCode = 500;
          res.end('{"error":"Failed to read stall fixtures"}');
        }
        return;
      }

      // Individual fixture — must end with .stall.json, no path traversal
      if (
        !segment.endsWith('.stall.json') ||
        segment.includes('/') ||
        segment.includes('..')
      ) {
        res.statusCode = 404;
        res.end('{"error":"Not found"}');
        return;
      }

      const fixturePath = path.join(fixturesDir, segment);
      if (!fs.existsSync(fixturePath)) {
        res.statusCode = 404;
        res.end('{"error":"Fixture not found"}');
        return;
      }

      try {
        res.setHeader('Content-Type', 'application/json');
        res.end(fs.readFileSync(fixturePath, 'utf-8'));
      } catch {
        res.statusCode = 500;
        res.end('{"error":"Failed to read fixture"}');
      }
    });
  },

  generateBundle() {
    // Emit each fixture file and a sorted index into dist/stall-fixtures/.
    const fixturesDir = path.resolve(import.meta.dirname, 'stall-fixtures');
    const files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.stall.json'));

    const metadata: Array<Omit<StallFixtureFile, 'spec' | 'stalledCandidates'>> = [];

    for (const filename of files) {
      const content = fs.readFileSync(
        path.join(fixturesDir, filename),
        'utf-8',
      );
      const fixture = JSON.parse(content) as StallFixtureFile;
      this.emitFile({
        type: 'asset',
        fileName: `stall-fixtures/${filename}`,
        source: content,
      });
      const { spec: _spec, stalledCandidates: _sc, ...meta } = fixture;
      metadata.push(meta);
    }

    metadata.sort(
      (a, b) =>
        a.unsolvedCells - b.unsolvedCells ||
        a.totalCandidates - b.totalCandidates,
    );

    this.emitFile({
      type: 'asset',
      fileName: 'stall-fixtures/index.json',
      source: JSON.stringify(metadata),
    });
  },
};
```

- [ ] **Step 2: Update the two fetch URLs in `web/src/main.ts`**

Find the line (around line 1978):
```ts
          const resp = await fetch('/dev/stall-fixtures');
```
Change to:
```ts
          const resp = await fetch('./stall-fixtures/index.json');
```

Find the line (around line 2059):
```ts
                  `/dev/stall-fixtures/${encodeURIComponent(meta.name)}`,
```
Change to:
```ts
                  `./stall-fixtures/${encodeURIComponent(meta.name)}.stall.json`,
```

- [ ] **Step 3: Verify dev server still serves fixtures**

```bash
cd web && npm run dev -- --port 5175
```

In a second terminal:
```bash
curl http://localhost:5175/stall-fixtures/index.json | head -c 200
```

Expected: JSON array starting with `[{"version":1,...`

Stop the dev server (Ctrl-C).

- [ ] **Step 4: Verify build emits fixtures**

```bash
cd web && npm run build
ls dist/stall-fixtures/ | head -5
cat dist/stall-fixtures/index.json | head -c 200
```

Expected: `index.json` plus 120 `*.stall.json` files in `dist/stall-fixtures/`.

- [ ] **Step 5: Run tests**

```bash
cd web && npm test 2>&1 | tail -5
```

Expected: all tests pass (no new tests needed — plugin behaviour is verified by the build check above).

- [ ] **Step 6: Commit**

```bash
cd .. && bash scripts/run-bronze-gate.sh 2>&1 | tail -5
git add web/vite.config.ts web/src/main.ts
git commit -m "feat: serve stall fixtures as static assets in production build"
```

---

## Task 2: Home screen flame toggle

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/main.ts`
- Modify: `web/public/styles.css`
- Modify: `web/e2e/flow.spec.ts`

- [ ] **Step 1: Add the flame button and `#fixture-panel` to `web/index.html`**

In the header, add the flame button immediately before `<button id="help-btn"`:
```html
    <button id="hard-puzzles-btn" class="btn-secondary btn-icon" data-tooltip="Hard puzzles">&#x1F525;</button>
```

After the closing `</section>` of `#upload-panel` (around line 56), add:
```html

  <!-- Hard Puzzles panel -->
  <section id="fixture-panel" class="card" hidden>
    <h2>Hard Puzzles</h2>
    <p class="fixture-intro">These puzzles defeat the rule engine — backtracking is needed to solve them. Load one, try to spot the missing rule, and share your idea via the feedback button.</p>
    <div id="fixture-list-content">
      <p id="fixture-loading" class="status">Loading&#x2026;</p>
    </div>
  </section>
```

- [ ] **Step 2: Add fixture table styles to `web/public/styles.css`**

Append at the end of the file:
```css
/* Fixture panel */
.fixture-intro {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-bottom: 1rem;
}

.fixture-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.fixture-table th {
  text-align: left;
  padding: 0.3rem 0.6rem;
  border-bottom: 1px solid var(--border);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.fixture-table td {
  padding: 0.35rem 0.6rem;
  border-bottom: 1px solid var(--border);
}

.fixture-table tbody tr {
  cursor: pointer;
}

.fixture-table tbody tr:hover {
  background: var(--surface-raised, var(--border));
}
```

- [ ] **Step 3: Add fixture state variables to `web/src/main.ts`**

Near the other module-level state variables (around line 105, where `draftBorderX` is declared), add:

```ts
// Active stall fixture — set when loaded from the fixture panel, cleared on normal pipeline start.
let currentFixtureName: string | null = null;
let currentFixtureUnsolvedCells: number | null = null;
let currentFixtureTotalCandidates: number | null = null;
```

- [ ] **Step 4: Replace the old dev panel block in `web/src/main.ts`**

Find and delete the entire old dev panel block. It starts with this comment:
```ts
    // Stall fixture dev panel — shown when ?dev=1 is in the URL.
```
and ends around line 2093 with `  }` (the closing brace of the outer `if (import.meta.env.DEV)` block is just after). Delete from the comment through the final closing `}` of that block.

- [ ] **Step 5: Add `loadFixtureList`, `renderFixtureTable`, and the button handler to `web/src/main.ts`**

Add these two functions before the `DOMContentLoaded` listener (after the `el` helper, around line 120):

```ts
// ---------------------------------------------------------------------------
// Hard Puzzles fixture panel
// ---------------------------------------------------------------------------

type FixtureMeta = Omit<StallFixtureFile, 'spec' | 'stalledCandidates'>;
let cachedFixtures: FixtureMeta[] | null = null;

async function loadFixtureList(): Promise<void> {
  if (cachedFixtures !== null) {
    renderFixtureTable(cachedFixtures);
    return;
  }
  try {
    const resp = await fetch('./stall-fixtures/index.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    cachedFixtures = (await resp.json()) as FixtureMeta[];
  } catch (err) {
    el<HTMLElement>('fixture-loading').textContent = 'Failed to load puzzle list.';
    console.error('[fixture-panel] fetch failed:', err);
    return;
  }
  renderFixtureTable(cachedFixtures);
}

function renderFixtureTable(fixtures: FixtureMeta[]): void {
  const container = el<HTMLElement>('fixture-list-content');
  // Remove all children without using innerHTML
  container.replaceChildren();

  const table = document.createElement('table');
  table.className = 'fixture-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of ['Puzzle', 'Unsolved', 'Candidates']) {
    const th = document.createElement('th');
    th.textContent = col;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const meta of fixtures) {
    const tr = document.createElement('tr');

    for (const val of [
      meta.name,
      String(meta.unsolvedCells),
      String(meta.totalCandidates),
    ]) {
      const td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    }

    tr.addEventListener('click', () => {
      void (async () => {
        try {
          const resp = await fetch(
            `./stall-fixtures/${encodeURIComponent(meta.name)}.stall.json`,
          );
          if (!resp.ok) return;
          const fixture = (await resp.json()) as StallFixtureFile;
          loadSpecDirect(fixture.spec);
          draftBorderX = fixture.spec.borderX.map((col) => [...col]);
          draftBorderY = fixture.spec.borderY.map((row) => [...row]);
          currentFixtureName = meta.name;
          currentFixtureUnsolvedCells = meta.unsolvedCells;
          currentFixtureTotalCandidates = meta.totalCandidates;
          const { board } = solveCurrentSpec();
          const playing = confirmPuzzle(board);
          renderPlayingMode(playing);
          appendCallouts(buildPlayingCallouts(playing.puzzleType !== 'classic'));
        } catch (err) {
          console.error('[fixture-panel] Failed to load fixture:', err);
        }
      })();
    });

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}
```

Inside the `DOMContentLoaded` listener, in the event handler setup section (near the other header button listeners), add:

```ts
  el<HTMLButtonElement>('hard-puzzles-btn').addEventListener('click', () => {
    const uploadPanel = el<HTMLElement>('upload-panel');
    const fixturePanel = el<HTMLElement>('fixture-panel');
    const showingFixtures = !fixturePanel.hidden;
    uploadPanel.hidden = showingFixtures;
    fixturePanel.hidden = showingFixtures;
    if (!showingFixtures) void loadFixtureList();
  });
```

- [ ] **Step 6: Clear fixture state when a normal pipeline load starts**

At the very top of `handleProcess()` (right after `clearActionLog()`, around line 855), add:

```ts
  currentFixtureName = null;
  currentFixtureUnsolvedCells = null;
  currentFixtureTotalCandidates = null;
```

- [ ] **Step 7: Add a tutorial callout for the flame button**

In `web/src/main.ts`, find `buildUploadCallouts`:
```ts
function buildUploadCallouts(): { id: string; text: string }[] {
  return [
    { id: 'process-btn',  text: 'Tap here to analyse your photo and detect the grid and cages.' },
    { id: 'help-btn',     text: 'Re-open this guide at any time.' },
    { id: 'feedback-btn', text: 'Found a bug or have a suggestion? Tap the envelope to send feedback.' },
    { id: 'config-btn',   text: 'Configure which logical rules run automatically.' },
  ];
}
```

Add the new entry after `process-btn`:
```ts
function buildUploadCallouts(): { id: string; text: string }[] {
  return [
    { id: 'process-btn',       text: 'Tap here to analyse your photo and detect the grid and cages.' },
    { id: 'hard-puzzles-btn',  text: 'Browse puzzles the rule engine cannot solve — try one and suggest a new rule.' },
    { id: 'help-btn',          text: 'Re-open this guide at any time.' },
    { id: 'feedback-btn',      text: 'Found a bug or have a suggestion? Tap the envelope to send feedback.' },
    { id: 'config-btn',        text: 'Configure which logical rules run automatically.' },
  ];
}
```

- [ ] **Step 8: Write a Playwright smoke test**

In `web/e2e/flow.spec.ts`, add this test after the last existing test:

```ts
test('hard-puzzles-btn toggles fixture panel and hides upload panel', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#upload-panel')).toBeVisible();
  await expect(page.locator('#fixture-panel')).toBeHidden();

  await page.click('#hard-puzzles-btn');
  await expect(page.locator('#fixture-panel')).toBeVisible();
  await expect(page.locator('#upload-panel')).toBeHidden();

  // Toggle back
  await page.click('#hard-puzzles-btn');
  await expect(page.locator('#upload-panel')).toBeVisible();
  await expect(page.locator('#fixture-panel')).toBeHidden();
});
```

- [ ] **Step 9: Run unit tests and the new Playwright test**

```bash
cd web && npm test 2>&1 | tail -5
npx playwright test --config playwright.dev.config.ts --grep "hard-puzzles-btn"
```

Expected: all unit tests pass; the new Playwright test passes.

- [ ] **Step 10: Commit**

```bash
cd .. && bash scripts/run-bronze-gate.sh 2>&1 | tail -5
git add web/index.html web/src/main.ts web/public/styles.css web/e2e/flow.spec.ts
git commit -m "feat: hard puzzles panel with flame toggle on home screen"
```

---

## Task 3: Rule suggestion feedback

**Files:**
- Modify: `worker/src/validate.ts`
- Modify: `worker/src/validate.test.ts`
- Modify: `worker/src/index.ts`
- Modify: `web/index.html`
- Modify: `web/src/main.ts`

### Worker changes (TDD)

- [ ] **Step 1: Write failing tests in `worker/src/validate.test.ts`**

Add these tests inside the existing `describe('isFeedbackReport', ...)` block, after the last `it(...)`:

```ts
  it('accepts feedbackType new-rule', () => {
    expect(isFeedbackReport({ ...validFeedback, feedbackType: 'new-rule' })).toBe(true);
  });

  it('accepts new-rule with all fixture fields', () => {
    expect(isFeedbackReport({
      ...validFeedback,
      feedbackType: 'new-rule',
      fixtureName: 'killer_sudoku_101',
      unsolvedCells: 5,
      totalCandidates: 12,
    })).toBe(true);
  });

  it('rejects fixtureName that is not a string', () => {
    expect(isFeedbackReport({ ...validFeedback, fixtureName: 42 })).toBe(false);
  });

  it('rejects unsolvedCells that is not a number', () => {
    expect(isFeedbackReport({ ...validFeedback, unsolvedCells: 'five' })).toBe(false);
  });

  it('rejects totalCandidates that is not a number', () => {
    expect(isFeedbackReport({ ...validFeedback, totalCandidates: true })).toBe(false);
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd worker && npm test 2>&1 | tail -10
```

Expected: 5 new tests fail — `isFeedbackReport` does not yet accept `'new-rule'` or validate the optional fields.

- [ ] **Step 3: Update `FeedbackReport` and `isFeedbackReport` in `worker/src/validate.ts`**

Replace the `FeedbackReport` interface:

```ts
export interface FeedbackReport {
  version: 3;
  reportedAt: string;
  appVersion: string;
  feedbackType: 'bug' | 'enhancement' | 'new-rule';
  bugCategory?: 'wrong-behaviour' | 'inaccurate-description';
  description: string;
  expected?: string;
  actionLog: string;
  puzzleSpec: unknown;
  userAgent: string;
  viewport: string;
  config: { alwaysApplyRules: string[]; autoPlacementDelay: number };
  exception?: string;
  fixtureName?: string;
  unsolvedCells?: number;
  totalCandidates?: number;
}
```

Replace `isFeedbackReport`:

```ts
export function isFeedbackReport(value: unknown): value is FeedbackReport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 3) return false;
  if (typeof v['reportedAt'] !== 'string') return false;
  if (typeof v['appVersion'] !== 'string') return false;
  if (
    v['feedbackType'] !== 'bug' &&
    v['feedbackType'] !== 'enhancement' &&
    v['feedbackType'] !== 'new-rule'
  ) return false;
  if (
    v['feedbackType'] === 'bug' &&
    v['bugCategory'] !== undefined &&
    v['bugCategory'] !== 'wrong-behaviour' &&
    v['bugCategory'] !== 'inaccurate-description'
  ) return false;
  if (typeof v['description'] !== 'string') return false;
  if (v['expected'] !== undefined && typeof v['expected'] !== 'string') return false;
  if (typeof v['actionLog'] !== 'string') return false;
  if (typeof v['userAgent'] !== 'string') return false;
  if (typeof v['viewport'] !== 'string') return false;
  if (typeof v['config'] !== 'object' || v['config'] === null) return false;
  if ('exception' in v && typeof v['exception'] !== 'string') return false;
  if (v['fixtureName'] !== undefined && typeof v['fixtureName'] !== 'string') return false;
  if (v['unsolvedCells'] !== undefined && typeof v['unsolvedCells'] !== 'number') return false;
  if (v['totalCandidates'] !== undefined && typeof v['totalCandidates'] !== 'number') return false;
  return true;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd worker && npm test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 5: Update `createFeedbackIssue` in `worker/src/index.ts`**

Replace the entire `createFeedbackIssue` function:

```ts
async function createFeedbackIssue(env: Env, data: FeedbackReport): Promise<void> {
  const typeLabel =
    data.feedbackType === 'bug' ? 'Bug report'
    : data.feedbackType === 'new-rule' ? 'Rule suggestion'
    : 'Enhancement request';

  const titleSnippet = data.description.slice(0, 72).replace(/[\r\n]+/g, ' ');
  const fixturePrefix = data.fixtureName ? ` ${data.fixtureName}:` : '';
  const title = `[${typeLabel}]${fixturePrefix} ${titleSnippet}${data.description.length > 72 ? '…' : ''}`;

  const labels = [
    'feedback',
    data.feedbackType === 'bug' ? 'bug'
    : data.feedbackType === 'new-rule' ? 'new-rule'
    : 'enhancement',
  ];
  if (data.bugCategory === 'inaccurate-description') labels.push('documentation');

  const config = data.config as { alwaysApplyRules?: unknown; autoPlacementDelay?: unknown };
  const rules = Array.isArray(config.alwaysApplyRules)
    ? (config.alwaysApplyRules as string[]).join(', ') || '(none)'
    : '?';
  const delay = typeof config.autoPlacementDelay === 'number'
    ? `${config.autoPlacementDelay}ms`
    : '?';

  const bugCatLine =
    data.feedbackType === 'bug' && data.bugCategory
      ? `**Category:** ${data.bugCategory === 'wrong-behaviour' ? 'Wrong behaviour' : 'Inaccurate description/documentation'}\n`
      : '';

  const expectedSection =
    data.feedbackType === 'bug' && data.expected
      ? `\n### Expected behaviour\n${data.expected}\n`
      : '';

  const exceptionSection = data.exception
    ? `\n## Exception\n\`\`\`\n${data.exception}\n\`\`\`\n`
    : '';

  const fixtureSection = data.fixtureName
    ? `\n**Fixture:** \`${data.fixtureName}\`  \n` +
      `**Unsolved cells:** ${data.unsolvedCells ?? '?'}  \n` +
      `**Total candidates:** ${data.totalCandidates ?? '?'}\n`
    : '';

  const specJson =
    data.puzzleSpec !== null
      ? `\n<details>\n<summary>Puzzle spec</summary>\n\n\`\`\`json\n${JSON.stringify(data.puzzleSpec, null, 2)}\n\`\`\`\n\n</details>\n`
      : '';

  const body = `## ${typeLabel}

**Reported:** ${data.reportedAt}
**App version:** ${data.appVersion}
**Browser:** ${data.userAgent}
**Viewport:** ${data.viewport}
${bugCatLine}${fixtureSection}
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
```

- [ ] **Step 6: Run worker tests once more**

```bash
cd worker && npm test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 7: Create the `new-rule` GitHub label in the repo**

```bash
gh label create "new-rule" --description "Suggested solver rule from the hard-puzzles panel" --color "7B61FF"
```

Expected: `Label 'new-rule' created in gbarrett28/cagedoku`.

- [ ] **Step 8: Deploy the updated worker**

```bash
cd worker && npm run deploy
```

Expected: `Deployed cagedoku-training-worker` (or similar version confirmation from Wrangler).

### Frontend changes

- [ ] **Step 9: Add the `feedback-type-new-rule` radio to `web/index.html`**

Find the `feedback-type-row` div:
```html
    <div class="feedback-type-row">
      <label><input type="radio" name="feedback-type" id="feedback-type-bug" value="bug"> Bug report</label>
      <label><input type="radio" name="feedback-type" id="feedback-type-enhancement" value="enhancement"> Enhancement request</label>
    </div>
```

Replace with:
```html
    <div class="feedback-type-row">
      <label><input type="radio" name="feedback-type" id="feedback-type-bug" value="bug"> Bug report</label>
      <label><input type="radio" name="feedback-type" id="feedback-type-enhancement" value="enhancement"> Enhancement request</label>
      <label><input type="radio" name="feedback-type" id="feedback-type-new-rule" value="new-rule"> Rule suggestion</label>
    </div>
```

- [ ] **Step 10: Update the feedback handler in `web/src/main.ts`**

**10a.** Find the `feedback-type-enhancement` change listener:
```ts
  el<HTMLInputElement>('feedback-type-enhancement').addEventListener('change', () => {
    el<HTMLElement>('feedback-bug-fields').style.display = 'none';
    el<HTMLElement>('feedback-description-label').textContent = 'What would you like to see?';
  });
```

Add immediately after it:
```ts
  el<HTMLInputElement>('feedback-type-new-rule').addEventListener('change', () => {
    el<HTMLElement>('feedback-bug-fields').style.display = 'none';
    el<HTMLElement>('feedback-description-label').textContent =
      'Describe the rule you think would unlock this puzzle.';
  });
```

**10b.** In `handleFeedbackSubmit`, replace the four-line block:
```ts
  const isBug = el<HTMLInputElement>('feedback-type-bug').checked;
  const feedbackType = isBug ? 'bug' : 'enhancement';
  const bugCategory = isBug
    ? (el<HTMLInputElement>('bug-cat-wrong').checked ? 'wrong-behaviour' : 'inaccurate-description')
    : undefined;
  const expected = isBug ? el<HTMLTextAreaElement>('feedback-expected').value.trim() || undefined : undefined;
```

With:
```ts
  const isBug = el<HTMLInputElement>('feedback-type-bug').checked;
  const isNewRule = el<HTMLInputElement>('feedback-type-new-rule').checked;
  const feedbackType = isBug ? 'bug' : isNewRule ? 'new-rule' : 'enhancement';
  const bugCategory = isBug
    ? (el<HTMLInputElement>('bug-cat-wrong').checked ? 'wrong-behaviour' : 'inaccurate-description')
    : undefined;
  const expected = isBug ? el<HTMLTextAreaElement>('feedback-expected').value.trim() || undefined : undefined;
  const fixtureRef = isNewRule && currentFixtureName !== null
    ? {
        fixtureName: currentFixtureName,
        unsolvedCells: currentFixtureUnsolvedCells ?? 0,
        totalCandidates: currentFixtureTotalCandidates ?? 0,
      }
    : {};
```

**10c.** In the same function, find the payload object. It ends with:
```ts
    exception: exceptionForSubmission ?? undefined,
  };
```

Change that closing to:
```ts
    exception: exceptionForSubmission ?? undefined,
    ...fixtureRef,
  };
```

- [ ] **Step 11: Run the bronze gate**

```bash
cd .. && bash scripts/run-bronze-gate.sh 2>&1 | tail -5
```

Expected: all checks pass.

- [ ] **Step 12: Run the full Playwright dev suite**

```bash
cd web && npx playwright test --config playwright.dev.config.ts
```

Expected: all tests pass including the toggle test from Task 2.

- [ ] **Step 13: Commit**

```bash
cd ..
git add web/index.html web/src/main.ts worker/src/validate.ts worker/src/validate.test.ts worker/src/index.ts
git commit -m "feat: rule suggestion feedback type with fixture reference"
```

---

## Final verification

- [ ] **Run the full silver gate**

```bash
bash scripts/run-silver-gate.sh 2>&1 | tail -20
```

Expected: all code checks pass; Playwright production suite passes.

- [ ] **Invoke finishing-a-development-branch skill**

REQUIRED SUB-SKILL: Use `superpowers:finishing-a-development-branch` to merge, push, and clean up.
