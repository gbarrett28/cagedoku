# Shipwright: extracting reusable agent methodology into a plugin

## Motivation

`CLAUDE.md` in this repo currently mixes two kinds of content:

1. **Methodology** — process rules that have nothing to do with sudoku or even
   with TypeScript: which skill to invoke and when, the two-tier quality-gate
   pattern, branch/doc/commit conventions, and even language coding
   guidelines (Python, TypeScript) that are really "how we like to write
   code," not "how this project works."
2. **Project-specific configuration** — what this codebase is, where things
   live, domain conventions (row-major grids), and the concrete tool wiring
   (serena, specific gate scripts, dev-server ports).

A new, largely-Python project is starting. Rather than copy-pasting
methodology prose into its `CLAUDE.md` and letting the two drift, the
methodology becomes a standalone, versioned, collaboratively-editable
**Claude Code plugin** — `shipwright` — that any project (including future
ones) installs and references, the same way this repo already references the
`superpowers` plugin.

## Repo & plugin structure

- New GitHub repo: `shipwright`, public, cloned locally to
  `C:\Users\geoff\PycharmProjects\shipwright`.
- Structured as a single-plugin marketplace, matching the shape `superpowers`
  and `pr-review-toolkit` already use:
  ```
  shipwright/
    .claude-plugin/
      marketplace.json       # lists this repo as a marketplace with one plugin: shipwright
      plugin.json             # plugin manifest (name, version, description)
    skills/
      using-shipwright/SKILL.md
      quality-gates/SKILL.md
      commit-and-test-integrity/SKILL.md
      issue-hygiene/SKILL.md
      tool-preferences/SKILL.md
      python-guidelines/SKILL.md
      typescript-guidelines/SKILL.md
    README.md                 # what this is, how to install, how to contribute
  ```
- Consuming projects install it once per machine:
  `/plugin marketplace add C:\Users\geoff\PycharmProjects\shipwright` then
  `/plugin install shipwright@shipwright`. No `@import` mechanism is needed —
  this reuses Claude Code's existing plugin/skill system.
- Each skill's frontmatter (`name`, `description`) follows the same
  convention as existing superpowers skills, so the "invoke if there's even a
  1% chance it applies" rule from `using-superpowers` covers `shipwright`
  skills too.

## Skills

### `using-shipwright` (entry skill, always relevant)

Mirrors `using-superpowers`'s role: the first thing that establishes *how*
to use the rest of the plugin. Contains:

- The required-skill-invocation table — which skill (from `superpowers` or
  `shipwright`) must be invoked at which moment. This subsumes the current
  "Required Superpowers" table in `killer_sudoku`'s CLAUDE.md; consuming
  projects no longer need their own copy of that table.
- Token Efficiency guidance (prefer fewest-total-tokens approach; inline
  execution over subagent-driven execution for plans).
- Plan Sprint Size guidance (~3 hours of inline execution per sprint,
  decomposition rules).
- Git Worktrees preference (don't use them; feature branches instead) — this
  is a Claude Code tooling caveat, not sudoku-specific.

### `quality-gates`

The two-tier bronze/silver gate pattern, described generically so it applies
to any language:

- **Bronze gate** — runs before every commit on a feature branch. A gate
  script executes fast checks (typecheck/lint + a fast test subset — see TDD
  interaction below) and, on success, writes a one-time token consumed by
  the pre-commit hook. The hook blocks the commit if no token is present.
  Bronze gate also carries a lightweight *manual* doc-hygiene check (not
  scripted — it doesn't count against the 5-minute runtime budget): any
  plan file touched by work in this commit must have its checkboxes
  accurately reflect reality — steps actually completed are ticked, steps
  not yet done are not. This is narrower than silver's full sweep (see
  below): it only concerns plans/specs relevant to the current commit, not
  every doc in the repo, and it doesn't require deleting a finished
  plan/spec — just that the checkboxes aren't lying. Do not commit if a
  touched plan's checkboxes are inaccurate.
- **Silver gate** — runs before merging to `master`/`main`. A gate script
  runs the full check suite (typecheck/lint + full test suite + any
  slow/integration/e2e tests) plus a manual doc-hygiene pass, then writes a
  token consumed by the pre-commit hook for the merge commit. Silver's doc
  pass is the thorough one: every spec/plan location in the repo is swept,
  finished specs are incorporated into live docs and deleted, finished plans
  (all steps ticked) are deleted — do not merge if any spec or plan file
  with unchecked steps remains.
- Each consuming project supplies its own `scripts/run-bronze-gate.sh` and
  `scripts/run-silver-gate.sh` implementing the checks appropriate to its
  language/stack (this repo's use `tsc`/`npm test`/`playwright`; the new
  Python project's would use `ruff`/`mypy`/`pytest`). The skill documents the
  *contract* (token-on-success, consumed-once, hook enforces per branch) —
  not the concrete commands.
- Branch Workflow: all work on a feature branch (`feature/short-description`),
  never commit directly to `master`; bronze gate gates every feature-branch
  commit, silver gate gates every master commit (see `--no-verify` ban).
- Doc Conventions: the spec/plan/live-doc lifecycle table (locations,
  "delete once incorporated/complete") that's currently duplicated as
  "Doc Conventions" + the doc-hygiene checklist inside "Quality Gates" in
  `killer_sudoku`'s CLAUDE.md. Consuming projects may override the default
  paths (`docs/specs/`, `docs/plans/`) in their own CLAUDE.md if they use
  different locations.

#### TDD ↔ Bronze Gate interaction (new requirement)

Tests written as part of `test-driven-development` (the failing test written
before implementation) **must** be added to the bronze gate's test run —
bronze gate is not allowed to skip newly-written tests. At the same time,
bronze gate's **total runtime must stay under 5 minutes**, since it runs on
every commit and a slow bronze gate erodes the incentive to commit in small
steps.

To reconcile these, the skill states the policy (not a specific
implementation):

- Tests are fast by default: no real I/O, no network calls, no sleeps, no
  slow fixture setup. A unit test suite of a few hundred fast tests
  comfortably fits in the 5-minute budget.
- If a test is inherently slow (integration test, real file/network I/O,
  browser automation), it must be tagged/excluded from the bronze subset
  (e.g. pytest `-m "not slow"`, or a separate `*.integration.test.ts` glob
  excluded from the bronze test command) and deferred to the silver gate,
  which has no runtime ceiling.
- If bronze gate's total runtime approaches the 5-minute ceiling as the
  suite grows, that is a signal to split further (tag more tests as slow) or
  optimize fixtures — not to skip running new tests.
- The bronze gate script's own test command is therefore expected to target
  a "fast" subset by construction, and each project's `run-bronze-gate.sh`
  must define what that subset is (e.g. by marker/tag or file-glob
  convention) as part of implementing the gate contract above.

This becomes a documented sub-section of `quality-gates`, cross-referenced
from `test-driven-development`'s natural entry point (writing a new test).

### `commit-and-test-integrity`

- Commit Conventions: Conventional Commits format, Co-Authored-By tag
  convention, and "always confirm before deleting or changing anything not
  committed to git."
- Test Specification Integrity: tests define the spec; when a test fails
  after a code change, assume the implementation is wrong first; changing a
  test requires documenting the spec change and getting explicit user
  approval.

### `issue-hygiene`

Generic policy for working with an issue tracker, deliberately written
tracker-agnostic (GitHub Issues, Linear, Jira, GitLab Issues, etc. all
qualify) — this is net-new content, not extracted from `killer_sudoku`'s
current CLAUDE.md, which has no issues section today:

- **Search before creating.** Check for an existing open (or recently
  closed) issue covering the same problem before filing a new one, to avoid
  duplicates accumulating over time.
- **Link work to issues.** When a commit or PR resolves an issue, reference
  it using the tracker's linking convention (e.g. GitHub's `Closes #123` /
  `Fixes #123` keywords) so closure is automatic and traceable, rather than
  closing manually with no link back to the change that fixed it.
- **Set the real closure reason**, not just "closed," when the tracker
  supports it (resolved vs. won't-fix vs. duplicate vs. not-planned) — a
  pile of issues closed with no reason recorded is no more useful than an
  open pile.
- **Keep descriptions current.** If investigation reveals the actual
  scope/root-cause differs from the original issue text, update the
  issue description to reflect current understanding rather than leaving a
  stale title/body that misleads the next reader.
- **Don't file an issue for something being fixed in the same session.**
  Issues track work that isn't actionable *right now*; filing one for a bug
  you're about to fix in the current change is process theater, not hygiene.
- Each project's own CLAUDE.md states which concrete tracker is in use and
  how to reach it (this repo: GitHub Issues via the `gh` CLI / `github` MCP
  plugin) — `issue-hygiene` states the policy generically, the same
  pattern `tool-preferences` uses for other tools.

### `tool-preferences`

Generic, availability-conditional tool preferences (currently scattered
across "Agent Protocol: Tool Use", "PR Review Tools", "Library
Documentation", "TypeScript Language Server" in `killer_sudoku`'s
CLAUDE.md):

- Prefer semantic/LSP-aware code-navigation tools (e.g. serena, a language
  server) over raw filesystem tools (`Read`, `Glob`, `Grep`) for code
  analysis and modification, when such a tool is installed and running.
- Prefer specialized review-agent plugins (e.g. `pr-review-toolkit`,
  `coderabbit`) over ad hoc manual review when installed.
- Prefer up-to-date library-documentation tools (e.g. `context7`) over
  training-data knowledge for external library/API usage, when installed.
- Each project's own CLAUDE.md states *which* concrete tool fills each role
  (this repo: serena for code nav, `typescript-lsp` for TS-specific
  diagnostics) — `tool-preferences` states the preference order and
  fallback behavior (ask the user to check the plugin/restart, don't
  silently fall back) generically.

### `python-guidelines`

The current "Python Coding Guidelines" section verbatim as reusable policy:
ruff strict rule-set + mypy strict, no inline `# noqa`/`# type: ignore` (use
`per-file-ignores` with a comment, or stub packages instead), the
safe-fix-then-unsafe-fix-with-review auto-fix workflow.

### `typescript-guidelines`

The current "TypeScript Coding Guidelines" section verbatim as reusable
policy: safety-by-construction philosophy, the namespace-merging pattern for
discriminated unions (with its worked example and warning signs), type
safety rules, code hygiene rules, error-handling rules.

## Changes to `killer_sudoku`'s `CLAUDE.md`

After `shipwright` exists and is installed for this repo, `CLAUDE.md` is
restructured to:

**Removed** (now owned by `shipwright` skills): Required Superpowers table,
Token Efficiency, Plan Sprint Size, Git Worktrees, PR Review Tools, Library
Documentation, Python Coding Guidelines, TypeScript Coding Guidelines,
Branch Workflow, Quality Gates (concept + generic hook description), Doc
Conventions, Test Specification Integrity, Commit Conventions.

**Kept** (project-specific): Project Overview, Codebase Map, Key Reference
Documents, Coordinate Conventions, Frontend Design Scope, UI Visual
Verification (dev-server specifics), Document Review Requests (this repo's
GitHub URL pattern), the concrete tool wiring (serena as the code-nav tool,
`typescript-lsp` plugin, the actual contents of
`scripts/run-bronze-gate.sh`/`run-silver-gate.sh`, `pyproject.toml` ruff/mypy
config).

**Added**: a short "Methodology" section near the top stating that
`shipwright` must be installed (marketplace path,
`/plugin install shipwright@shipwright`) and pointing at
`using-shipwright` as the entry point, the same way the current doc points
at `superpowers:using-superpowers` implicitly via the required-skills table.
Since this repo has no existing issues section, `issue-hygiene`'s policy
applies via that same pointer with no project-specific override needed
beyond noting the concrete tracker (GitHub Issues via `gh`/`github` MCP,
already in use for this repo's PR workflow).

The existing `scripts/run-bronze-gate.sh` is checked against the new bronze
gate contract (token-on-success semantics already match; the fast-subset
requirement from the TDD interaction section above may require confirming
`npm test` in this repo is already fast enough, or splitting it — this is
verified, not redesigned, during implementation since `killer_sudoku`'s test
suite is TypeScript/Vitest, not Python).

## Out of scope

- The new Python project's own `CLAUDE.md` — that happens in a future
  session once the project exists, by installing `shipwright` and writing a
  project-specific `CLAUDE.md` following the same "kept vs removed" pattern
  as above.
- Any change to `scripts/run-bronze-gate.sh` / `run-silver-gate.sh` content
  beyond verifying they already satisfy the bronze-gate-under-5-minutes /
  TDD-tests-included contract (memory already records bronze gate at ~150s,
  well under the 5-minute ceiling, so no split is expected to be needed for
  this repo).
- Inviting external collaborators to `shipwright` — the repo is created
  public so that's possible later, but no specific collaborators are added
  as part of this work.
- An `html-css-guidelines` skill — considered and deliberately deferred:
  unlike `python-guidelines`/`typescript-guidelines`, there's no existing
  enforced HTML/CSS convention in `killer_sudoku` to extract, and inventing
  rules with no proven usage risks baking untested preferences into a
  shared plugin. Add this skill later if/when a project has real,
  already-enforced HTML/CSS conventions worth generalizing.

## Verification approach

- `shipwright` repo: each skill's frontmatter is valid, the plugin installs
  cleanly via `/plugin marketplace add` + `/plugin install` in a scratch
  check, and `using-shipwright` is confirmed to trigger (e.g. by asking a
  question that should invoke it and observing the skill fire).
- `killer_sudoku`: after restructuring CLAUDE.md, the bronze gate
  (`bash scripts/run-bronze-gate.sh`) is run and must still pass, confirming
  the restructure didn't silently drop an enforced check.
