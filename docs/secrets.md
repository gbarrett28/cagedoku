# Secrets and Access Tokens

Where every credential used by this project lives, who consumes it, how to
rotate it, and how you find out it has stopped working. **No credential value
belongs in the repository, in a commit message, or in a chat with an agent.**
Values are always entered by the human (`gh secret set NAME` reads the value
from stdin; the Windows Environment Variables dialog avoids shell history).

Last reviewed: 2026-10-04.

## Where secrets can live

| Store | What is kept there | Visible to |
|---|---|---|
| GitHub Actions repository secrets | CI credentials | Workflow runs on this repo (masked in logs) |
| GitHub Actions repository variables | Non-secret config (`TRAINING_WORKER_URL`) | Workflow runs; readable by repo collaborators |
| Cloudflare Worker secret | The Worker's outbound GitHub token | The deployed Worker only |
| Windows credential store (via `gh auth login`) | Local `gh` CLI login | Your Windows user |
| Windows user environment variable | Token for the GitHub MCP plugin | Processes started from your logon session |

The repo is **public**, so anything committed is world-readable. GitHub has no
Dependabot secrets, deploy keys or webhooks configured; the only GitHub
environment is `github-pages` (no secrets).

## Inventory

| Credential | Store | Consumed by | Scope / permissions | Set / rotated by | Failure symptom |
|---|---|---|---|---|---|
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Actions secrets | `scripts/_r2_list.py`, `_r2_download.py`, `_r2_delete.py` (boto3, S3 API) in `puzzle-spec-review.yml`, `rule-regression.yml`, `retrain.yml` | Cloudflare R2 API token: Object Read & Write, bucket `cagedoku-training` only | Create token in Cloudflare R2 > Manage API Tokens, then `gh secret set` for both | `puzzle-spec-review` red with `AccessDenied` on `ListObjectsV2` |
| `CLOUDFLARE_API_TOKEN` | Actions secret | `worker-deploy.yml` (`wrangler-action`) | Cloudflare token with Workers deploy rights | Create in Cloudflare dashboard, then `gh secret set CLOUDFLARE_API_TOKEN` | Deploy step fails on the next push touching `worker/`. Deploys are rare, so expiry can sit unnoticed. |
| `GITHUB_TOKEN` (Worker) | Cloudflare Worker secret | `worker/src/index.ts` `postToGitHub` / `createGitHubIssue`: comments on Issue #1 and opens issues | GitHub PAT, Issues write on this repo | `cd worker && npx wrangler secret put GITHUB_TOKEN` (prompts for value) | Uploads still succeed (stored in R2) but no GitHub notification or issue appears |
| `GITHUB_TOKEN` (workflow) | Automatic per run | Checkout, PRs, issues in workflows | Per-workflow `permissions:` block | Nothing to manage | n/a |
| `gh` CLI login | Windows credential store (`gho_` OAuth token) | Local `gh` commands | `gist`, `read:org`, `repo`, `workflow` | `gh auth login` / `gh auth refresh` | `gh auth status` reports invalid |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Windows **user** environment variable | GitHub MCP plugin: `.mcp.json` sends `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}` | Fine-grained PAT (`github_pat_…`) | GitHub > Settings > Developer settings, then edit the user variable and **sign out and back in** | MCP fails with HTTP 401 "credential expired" |

Not credentials, despite appearances:
- Cloudflare account ID `b6c5bf0f26c81c4901c4434c6a3ca23f` is hardcoded in `worker-deploy.yml`; it is an identifier.
- The "Token value" Cloudflare shows next to the R2 Access Key pair is its native-API token. No script here uses it, so it is not stored anywhere.
- The Worker reaches R2 through a binding (`TRAINING_BUCKET` in `worker/wrangler.toml`), so it needs no R2 key.
- `.bronze-gate-ok` / `.silver-gate-ok` are local one-shot commit-gate markers, not secrets.
- `TRAINING_WORKER_URL` is a public URL, kept as a repository **variable** (`vars.TRAINING_WORKER_URL`, used by `pages.yml` as `VITE_TRAINING_WORKER_URL` and by `rule-regression.yml`). If it is missing or wrong, uploads are silently disabled in the built app and the fixture fetch fails. Change it with `gh variable set TRAINING_WORKER_URL --body <url>`.
- `web/.env.production` (gitignored) is an optional local copy of `VITE_TRAINING_WORKER_URL` for local production builds.

## Procedures

### Rotate the R2 S3 keys
1. Cloudflare dashboard > R2 > Manage API Tokens > Create API Token.
2. Permission *Object Read & Write*, scoped to bucket `cagedoku-training`, **no expiry** (or a long one recorded below).
3. Copy the Access Key ID and Secret Access Key (shown once).
4. `gh secret set R2_ACCESS_KEY_ID` then `gh secret set R2_SECRET_ACCESS_KEY`.
5. Verify: `gh workflow run puzzle-spec-review.yml`, expect a green run with `Found N puzzle-spec object(s).` in the *List* step.

### Rotate the Worker's GitHub token
1. Create a fine-grained PAT limited to `gbarrett28/cagedoku`, **Issues: read and write** only, longest practical expiry.
2. `cd worker && npx wrangler secret put GITHUB_TOKEN` and paste the value at the prompt.
3. Verify by submitting a feedback report from the app and checking Issue #1.

### Rotate the Cloudflare deploy token
1. Cloudflare dashboard > My Profile > API Tokens, using a Workers-edit template for the account.
2. `gh secret set CLOUDFLARE_API_TOKEN`.
3. Verify by re-running `worker-deploy.yml` (workflow dispatch or a push touching `worker/`).

### Rotate the local GitHub MCP token
1. Create a new fine-grained PAT (repo `gbarrett28/cagedoku`: Contents, Issues, Pull requests, Actions; Metadata read).
2. Edit the **user** variable `GITHUB_PERSONAL_ACCESS_TOKEN` (Win+R, `rundll32 sysdm.cpl,EditEnvironmentVariables`).
3. **Sign out of Windows and back in.** The desktop app is a Microsoft Store (MSIX) app. Relaunching it was observed (2026-10-04) to keep the previous value even though the saved user variable was already new, so an app restart alone does not refresh it.
4. Check from a fresh PowerShell: `curl.exe -sI https://api.github.com/user -H "Authorization: Bearer $env:GITHUB_PERSONAL_ACCESS_TOKEN" | findstr /i "HTTP github-authentication-token-expiration"` should show `HTTP/2 200` and an expiry date.

## Expiry register

Fill in from the Cloudflare and GitHub dashboards; nothing alerts on expiry, so this table is the alert.

| Credential | Created | Expires | Notes |
|---|---|---|---|
| R2 S3 keys | 2026-09-18 | **Unknown, suspected 14 days (broke 2026-10-02)** | Re-created after the first break on 2026-08-08 |
| `CLOUDFLARE_API_TOKEN` | 2026-05-17 | unknown | Last exercised by a deploy 2026-06-18 |
| Worker `GITHUB_TOKEN` | unknown | unknown | Cannot be inspected from outside Cloudflare |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | 2026-10-04 | unknown | Previous token expired and broke the MCP |
| `gh` login | unknown | does not expire by default | |

## Health checks

- **R2:** `puzzle-spec-review` is the canary. It lists R2 every run, and when a run fails it opens a GitHub issue titled "Review puzzle-spec uploads is failing" (one at a time, closed automatically by the next successful run). `Sync rule-bug fixtures` is *not* a canary: it only calls R2 when there are fixtures to drain, so it stays green with dead keys.
- **GitHub CLI:** `gh auth status`.
- **Worker token:** no automated check; a dead token loses notifications silently.
- **Cloudflare deploy token:** only exercised on deploy.

## Review (2026-10-04): are all of these necessary?

**R1. `TRAINING_WORKER_URL` is not a secret. Converted to a repository variable. (Done; one cleanup step pending.)**
The repo is public, the URL is printed in `docs/architecture.md`, and it is compiled into the deployed JS bundle, so storing it as a secret protected nothing. The variable `vars.TRAINING_WORKER_URL` now exists and `pages.yml` and `rule-regression.yml` read it. **Pending:** once this change is merged to `master` and one `rule-regression` run has passed, delete the old secret with `gh secret delete TRAINING_WORKER_URL`. Deleting it earlier would break the `master` workflows, which still read the secret until the merge.

**R2. The local GitHub token duplicates `gh`.**
The `gh` login and the MCP's PAT are two credentials for one account, and `gh` already covers CI, issues and PRs (see the tool table in `CLAUDE.md`). The PAT's only job is feeding the GitHub MCP plugin, and it caused the 2026-10-04 outage. Recommended: disable the `github` plugin and delete the PAT and its user variable. If the MCP's structured tools are wanted, keep it but give the PAT a long expiry. That removes a whole storage mechanism (the environment variable, and the Windows sign-out quirk with it).

**R3. Keep both Cloudflare credentials.**
They do different jobs: the deploy token manages Workers, the S3 keys read and write bucket data. Merging them would need a broader token and bring no real saving.

**R4. The R2 S3 keys are necessary** for Actions to list, download and delete pending uploads. Replacing them with authenticated Worker endpoints would still need a shared secret, so no reduction.

**R5. The Worker's `GITHUB_TOKEN` is necessary** for notifications and report-to-issue creation. Confirm it is fine-grained, limited to this repo and Issues-only. Note that anyone who can send a valid report can cause the Worker to open issues with it (see below), so its blast radius should stay at "create issues here".

**R6. Workflow `GITHUB_TOKEN`** is automatic and fine.

Net effect once the pending secret deletion is done and R2 is accepted: Actions secrets 4 → 3 entries, local credentials 2 → 1, secret stores 4 → 3. R2 (dropping the GitHub MCP plugin and its PAT) is still undecided.

### Related exposure (not a secret, but affects the token's risk)
- `GET /rule-fixtures/:ruleName` on the Worker needs no authentication.
- `POST` is gated only by an `Origin` allow-list (`*.github.io`). Any non-browser client can send a forged `Origin`, so this is not authentication.
- Only `training/`, `puzzle-spec/` and `stall/` uploads are capped (`MAX_PENDING_UPLOADS`); other report types are not.
- Combined with the Worker's PAT, this lets an outsider trigger issue creation on the repo. Acceptable for a hobby project; worth a rate limit or shared-secret header if abuse appears.

### Process gaps
- `puzzle-spec-review` now raises an issue when it fails (covers the R2 keys). Nothing alerts on the other credentials expiring: the Worker token and the Cloudflare deploy token are only exercised rarely.
- The expiry register above is manual.
