# Investigate bot — design & rewrite plan

Status: design locked, rewrite not started. Supersedes the original PR #1090 scaffolding.

## Goal

A bot a maintainer invokes (by label) to investigate an EmDash issue end to end. The bot reproduces the bug, optionally writes and verifies a fix, posts evidence including screenshots, and asks the reporter to confirm before any PR enters our queue.

Modelled on Astro's `.flue/agents/issue-triage.ts` flow, with three intentional differences:

- **Maintainer-initiated, not auto-fired** — we trigger via a `bot:repro` label, not on every `issues.opened`.
- **No draft PRs in the queue** — the bot pushes branches and asks for verification; PRs are only opened after the reporter confirms.
- **Inline screenshots via an orphan artifact branch** — no Cloudflare token, no external bucket.

## Why this design

Calibrated against a 100-issue appraisal of our recent queue:

- ~38% AUTO candidates (fix tractable, testable on existing harness)
- ~24% ASSIST candidates (reproduce + failing test is high value, fix is risky)
- ~38% HUMAN candidates (features, cross-isolate architecture, ops)

The bot's value is concentrated in two activities:

1. **Reproduction.** Even when the bot can't fix a bug, the failing test it leaves behind is a permanent regression check we'd otherwise skip writing.
2. **Reporter-verified fixes on tractable bugs.** The reporter, not the maintainer, is the only person who can reliably verify that a fix solves the actual problem they reported.

Browser access (`agent-browser` against `pnpm dev`) shifts ~6 admin-UI issues from HUMAN to ASSIST/AUTO. Worth the complexity.

## Trigger and state

One label triggers the bot. The bot then manages its own label as the investigation progresses. Labels are mutually exclusive on a single issue.

| Label                   | Set by     | Meaning                                              |
| ----------------------- | ---------- | ---------------------------------------------------- |
| `bot:repro`             | Maintainer | Investigation requested                              |
| `bot:reproducing`       | Bot        | Investigation in progress                            |
| `bot:reproduced`        | Bot        | Reproduced; no fix attempted (low confidence)        |
| `bot:awaiting-reporter` | Bot        | Reproduced + fix attempted; reporter asked to verify |
| `bot:verified`          | Bot        | Reporter confirmed; PR opened                        |
| `bot:not-reproduced`    | Bot        | Could not observe the reported behaviour             |
| `bot:skipped`           | Bot        | Declined (needs user data, host-specific, etc.)      |
| `bot:failed`            | Bot        | Gave up after retries                                |

A GitHub Project board mirrors these as columns via saved label queries. One-time UI setup; the bot does not touch the board directly.

## Workflows

Three GitHub Actions workflows.

### 1. `investigate.yml`

Triggered by `issues.labeled` with `bot:repro`. Runs the Flue `investigate` workflow inside a GH Actions runner.

Steps:

1. Mint App installation token (scoped: `issues: write, contents: write, pull-requests: write` on this repo only).
2. Workflow YAML transitions label: `bot:repro` → `bot:reproducing`.
3. Checkout, setup pnpm + node, install, build.
4. `pnpm exec flue run investigate` with payload `{ issueNumber, issueTitle, issueBody, owner, repo, retryContext? }`.
5. Workflow YAML reads structured output JSON; pushes branches; posts comment; transitions label to terminal state.

Bot's stages inside the workflow (each a separate skill, structured output between):

1. **Reproduce** — sub-skill chosen by classifier output (`repro-api` / `repro-admin` / `repro-public`). Returns `{ reproduced, approach, notes, screenshots }`.
2. **Diagnose** — read the code paths that explain the reproduction. Returns `{ rootCause, confidence: 'high' | 'medium' | 'low' }`.
3. **Verify** — is this actually a bug or intended behaviour? Returns `{ verdict: 'bug' | 'intended-behavior' | 'unclear' }`. If `intended-behavior`, the pipeline short-circuits.
4. **Fix** — conditional on `verify.verdict === 'bug'` AND `diagnose.confidence === 'high'`. Writes the fix, runs the failing test, confirms it now passes. Returns `{ fixed, commitMessage, filesChanged }`.

Terminal label after a run:

- Reproduce skipped → `bot:skipped`
- Reproduce returned `reproduced: false` → `bot:not-reproduced`
- Verify returned `intended-behavior` → `bot:reproduced` (with explanation in comment)
- Fix attempted and `fixed: false` → `bot:reproduced`
- Fix attempted and `fixed: true` → `bot:awaiting-reporter`

### 2. `reporter-reply.yml`

Triggered by `issue_comment.created`. Filters: issue carries `bot:awaiting-reporter`, comment author is the issue author.

Steps:

1. Mint App token.
2. Classify the reply with a cheap kimi call: `positive | negative | unclear`.
3. **positive** — open PR from `bot/fix-<n>`. Apply `bot:verified`. Remove `bot:awaiting-reporter`. Comment on the new PR with the reporter quote.
4. **negative** — increment retry counter (stored in a hidden HTML comment on the issue, or in a per-issue gist; TBD during build). If < 3 retries, re-invoke `investigate.yml` via `workflow_dispatch` with `retryContext: <reporter comment body>`. If ≥ 3, apply `bot:failed` and ping the maintainer who originally added `bot:repro`.
5. **unclear** — post a one-sentence clarifying question. No state change.

### 3. `bot-cleanup.yml`

Two triggers:

- `issues.closed` — delete `bot/fix-<n>` if no PR was ever opened from it; delete `bot/artifacts-<n>` unconditionally.
- Daily cron — list all `bot/artifacts-*` branches; for each whose newest commit is older than 90 days, delete it. Catches stale artifacts on issues that stay open forever.

## Token model

Two distinct tokens, mirroring Astro's two-token split.

| Token              | Scope                                                                                                                                             | Used by                                                                                                               | Holds what                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Sandbox token      | Default `secrets.GITHUB_TOKEN`; job permissions: `contents: read, issues: read`                                                                   | The agent's `local()` sandbox, exposed as `GH_TOKEN` to `bash`                                                        | Inside the agent's shell only                            |
| Orchestrator token | App installation token via `actions/create-github-app-token`, scoped to `emdash` repo with `issues: write, contents: write, pull-requests: write` | The workflow YAML and any TS orchestrator code that does writes (label changes, comments, branch pushes, PR creation) | Workflow `process.env`; never passed to `local({ env })` |

A jailbroken agent's bash gets only the sandbox token — can read issues, can clone, can run `gh issue view`. Cannot comment, label, push branches, or open PRs. The orchestrator token never crosses into the sandbox.

## Branches

Two branches per investigation, both managed by the orchestrator:

- **`bot/fix-<n>`** — code changes only. This becomes a PR if the reporter verifies. Lives until either the PR merges or the issue closes.
- **`bot/artifacts-<n>`** — orphan branch with screenshots only. Never merged. Referenced from comment markdown as `https://raw.githubusercontent.com/emdash-cms/emdash/bot/artifacts-<n>/<path>.png`. Deleted when the issue closes.

The artifact branch is created with `git checkout --orphan` so it shares no history with `main`; its only commits are screenshot uploads.

## Skills

Seven markdown files. Bundled as Flue 0.8 imported skills, so they ship with the build and work identically in CI (Node) and any future deploy.

| Skill                  | Purpose                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `investigate/SKILL.md` | Parent skill. Reads the issue, classifies type, dispatches to the right sub-skill, orchestrates the 4 stages.                                                |
| `repro-api.md`         | Reproduce API/CLI/MCP/migration bugs. No browser. Uses `pnpm test`, direct API hits via `gh` or `curl localhost:4321`, fixture setup via CLI.                |
| `repro-admin.md`       | Reproduce admin UI bugs. Starts `pnpm dev` via `bgproc`, uses dev-bypass for auth, drives `agent-browser`, captures screenshots, observes console + network. |
| `repro-public.md`      | Reproduce public-page rendering bugs. Seeds content via CLI, then `agent-browser open http://localhost:4321/<route>`.                                        |
| `diagnose.md`          | Read the code paths that explain the reproduction. Output `rootCause` (file:line plus prose) + `confidence`.                                                 |
| `verify.md`            | Decide whether the reproduced behaviour is actually a bug. Compare against documented intent.                                                                |
| `fix.md`               | Write the fix. Run the failing test. Confirm it now passes. Commit to `bot/fix-<n>`.                                                                         |

The parent skill includes the dispatch logic: classify the issue into `kind: bug/enhancement/documentation/question` and `area: api/admin/public/migration/build/other`, then read the appropriate sub-skill.

## Classifier

A shared `createAgent(...)` factory in `lib/classifier.ts` used by:

- The parent `investigate` skill, to decide which `repro-*` sub-skill to load.
- The `reporter-reply.yml` workflow, to classify reporter replies as positive/negative/unclear.
- The local prototype runner, to iterate on the classification prompt.

Model: `cloudflare/@cf/moonshotai/kimi-k2.6` routed through our AI Gateway. Cheap and consistent for a structured classification task.

## Screenshots

The bot saves screenshots locally during reproduction (`./.bot-artifacts/<step>.png`). After the run completes, the workflow YAML:

1. Checks out the orphan `bot/artifacts-<n>` branch (creating if absent).
2. Copies `.bot-artifacts/*` over the working tree.
3. Commits, force-pushes with the App token.
4. The agent's structured output already includes a `screenshots: [{ filename, description }]` array; the orchestrator interpolates `![desc](raw URL)` into the final comment body.

This means the agent doesn't need to know GitHub's URL format. It just writes files and describes them. The orchestrator does the URL construction.

## File layout

```
.flue/
├── lib/
│   ├── classifier.ts            # createAgent factory + classifyReply helper
│   └── github.ts                # Octokit wrappers (comment, label, branch push, PR open)
├── skills/
│   ├── investigate/SKILL.md     # Parent
│   ├── repro-api.md
│   ├── repro-admin.md
│   ├── repro-public.md
│   ├── diagnose.md
│   ├── verify.md
│   └── fix.md
├── workflows/
│   └── investigate.ts           # Single workflow with 4 stages
├── scripts/
│   └── run-local.ts             # Local prototype runner; spawns `flue run investigate` with a fixture payload
├── fixtures/                    # 5 real issues (#1021, #1042, #1046, #1049, #1080)
├── package.json                 # Flue 0.8
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.json
└── README.md

.github/workflows/
├── investigate.yml              # bot:repro → investigate workflow
├── reporter-reply.yml           # author replies → classify + act
└── bot-cleanup.yml              # issues.closed + daily cron

scripts/                         # repo-level (new)
└── setup-bot-labels.mjs         # One-shot: idempotent gh label create for the 8 bot:* labels
```

Removed from the current PR #1090 tree:

- `.flue/agents/triage-label.ts`, `.flue/agents/triage-issue.ts`, `.flue/agents/repro-issue.ts`
- `.flue/app.ts`
- `.flue/wrangler.jsonc`
- `.flue/lib/verify-signature.ts` (no webhook → no HMAC)
- `.github/workflows/auto-repro.yml` (replaced)
- `skills/reproduce/SKILL.md` at the repo root (replaced by `.flue/skills/repro-*.md`)

## Local prototype runner

`scripts/run-local.ts` keeps the shape it has now. Spawns `flue run investigate` with a fixture payload and prints the structured output. No GitHub writes (no token in env), no branches pushed; the orchestrator's role is simulated by just dumping the result.

Required env, same as today:

```
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_GATEWAY_ID
CLOUDFLARE_API_TOKEN
```

## Build order

Three phases. Each phase committed separately so the diff is reviewable.

### Phase 1 — tear down + restructure (~15 min)

- Delete `agents/`, `app.ts`, `wrangler.jsonc`, `lib/verify-signature.ts`, `alchemy.run.ts` (already gone), the existing `auto-repro.yml`.
- Move `skills/reproduce/SKILL.md` from repo root into `.flue/skills/`.
- Create empty `workflows/`, expanded `skills/`.
- Bump `package.json` to `@flue/runtime@0.8.0` and `@flue/cli@0.8.0`.
- Update `tsconfig.json` includes.

Commit: `refactor(triage): tear down phase 1 scaffolding for full pipeline rewrite`

### Phase 2 — build the Flue workflow + skills (~90 min)

- Write `workflows/investigate.ts` with the 4-stage pipeline. Stage-to-stage handoff via structured valibot schemas.
- Write `lib/classifier.ts` with the shared classifier factory + `classifyReply` helper.
- Write the 7 skill markdown files.
- Update `scripts/run-local.ts` to invoke `investigate` against fixtures.
- Verify `pnpm typecheck` + `flue build --target node` + `flue build --target cloudflare` all clean.

Commit: `feat(triage): four-stage investigate workflow with classifier-dispatched sub-skills`

### Phase 3 — wire GH Actions (~60 min)

- Write `investigate.yml` with App-token minting, sandbox-token isolation, label state transitions, branch pushes.
- Write `reporter-reply.yml` with the kimi classification step and retry logic.
- Write `bot-cleanup.yml` with the two triggers.
- Write `scripts/setup-bot-labels.mjs` (idempotent label creation).
- Document the one-time GitHub Project board setup in `README.md`.

Commit: `feat(ci): investigate workflows with reporter-reply loop and artifact cleanup`

### Phase 4 — README, PR description (~30 min)

- Rewrite `.flue/README.md` for the new architecture
- Rewrite the PR #1090 description
- Add a section explaining the one-time setup (App, labels, Project board)

Commit: `docs(triage): rewrite README and PR description for the investigate flow`

Total estimate: ~3.5 hours focused work.

## Open questions before starting

1. **Where does the retry counter live?** Options: hidden HTML comment on the issue (works, ugly), a per-issue gist (one extra API call), a custom Project board field. Will decide during Phase 3 — leaning toward HTML comment for simplicity, can upgrade later.

2. **Should `verify.yml` (the PR-side check) ship in this rewrite?** I left it out of the plan. Could be a small follow-up PR — same workflow, different ingress (`bot:verify` label on a PR), checks out the PR's head, runs the reproduce stage against the PR's branch. Adds value but is independent.

3. **Naming for the artifact branch.** `bot/artifacts-<n>` is what I've used. Alternatives: `bot/screenshots-<n>` (more specific), `_bot-artifacts/<n>` (underscore prefix makes it sort separately). Slight preference for `bot/artifacts-<n>` but happy to change.

4. **First test issue.** Once the bot is live, we need to add `bot:repro` to a real issue and watch what happens. Candidates from the AUTO bucket appraisal: #994 (mirror 6 endpoints, very predictable), #1188 (CLI envelope mismatch, well diagnosed), or #1062 (one-line template fix). I'd start with #1062 — lowest blast radius, fastest feedback.
