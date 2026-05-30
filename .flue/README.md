# Investigate bot

Experimental Flue-powered investigation bot for `emdash-cms/emdash` issues. Runs as a GitHub Actions workflow when a maintainer applies the `bot:repro` label. Not deployed as a Cloudflare Worker.

For the design rationale, see [PLAN.md](./PLAN.md) and the [PR description](https://github.com/emdash-cms/emdash/pull/1090). Astro's analogous setup (`.flue/agents/issue-triage.ts` in `withastro/astro`) is the closest reference.

## What it does

When a maintainer adds `bot:repro` to an issue:

1. **Classify** — kimi-k2.6 decides issue kind/area/whether a browser is needed.
2. **Reproduce** — opus runs in a `local()` sandbox on the GH Actions runner. Picks one of three sub-skills:
   - `repro-api` — `pnpm test`, CLI commands, direct API hits, no browser
   - `repro-admin` — `agent-browser` against `pnpm dev` with the dev-bypass auth shortcut
   - `repro-public` — `agent-browser` against the rendered public site
3. **Diagnose** — read the source paths that explain the symptom, rate confidence honestly.
4. **Verify** — decide whether the behaviour is a bug or intended-by-design. Gates the fix stage.
5. **Fix** — conditional on `verdict=bug` AND `confidence=high`. Writes the change, runs the reproduce test, runs the broader package tests, typecheck, lint, format. Stages but does not commit.

The orchestrator (`.github/workflows/investigate.yml`) reads the structured JSON output and performs all GitHub writes — labels, comments, branch pushes, PR creation. The agent itself has no write access to GitHub.

## Trigger and label state

| Label                   | Set by     | Meaning                                          |
| ----------------------- | ---------- | ------------------------------------------------ |
| `bot:repro`             | Maintainer | Investigation requested                          |
| `bot:reproducing`       | Bot        | Investigation in progress                        |
| `bot:reproduced`        | Bot        | Reproduced; no fix attempted (or fix abandoned)  |
| `bot:awaiting-reporter` | Bot        | Fix pushed; reporter asked to verify             |
| `bot:verified`          | Bot        | Reporter confirmed; PR opened                    |
| `bot:not-reproduced`    | Bot        | Could not observe the reported behaviour         |
| `bot:skipped`           | Bot        | Declined (non-bug, requires external data, etc.) |
| `bot:failed`            | Bot        | Gave up after retries                            |

The bot owns every label except `bot:repro`. Maintainers don't manage state directly — they trigger by adding `bot:repro` and re-trigger by removing/re-adding it.

## File layout

```
.flue/
├── lib/
│   └── classifier.ts          # Shared kimi classifier + reply-classifier schemas
├── skills/
│   ├── _INVESTIGATE.md        # Reference doc; not imported as a Flue skill
│   ├── diagnose/SKILL.md
│   ├── fix/SKILL.md
│   ├── repro-admin/SKILL.md
│   ├── repro-api/SKILL.md
│   ├── repro-public/SKILL.md
│   └── verify/SKILL.md
├── workflows/
│   ├── investigate.ts         # 4-stage pipeline
│   └── classify-reply.ts      # Reporter-reply classifier
├── scripts/
│   └── run-local.ts           # Local prototype runner
├── fixtures/                  # 5 real issues for local iteration
└── package.json               # Flue 0.8

.github/workflows/
├── investigate.yml            # bot:repro → investigate workflow
├── reporter-reply.yml         # Reporter comments on a bot-awaited issue
└── bot-cleanup.yml            # Branch cleanup on issue close + daily cron
```

## Token model

Two distinct tokens per investigation, mirroring `withastro/astro`'s split:

- **Sandbox token** (`AGENT_GH_TOKEN`): default `secrets.GITHUB_TOKEN`, scoped to `contents: read, issues: read` via the job's `permissions:`. The only token in `local({ env })`. The agent's bash can clone the repo and run `gh issue view`; it cannot comment, label, or push.
- **Orchestrator token**: a GitHub App installation token minted by `actions/create-github-app-token`, scoped to `issues: write, contents: write, pull-requests: write` on this repo only. Lives in the workflow YAML and is used for all writes. Never crosses into the sandbox env.

A complete jailbreak of the agent's bash cannot escalate to comment, label, branch-push, or PR-create writes — those require the orchestrator token, which the sandbox never sees.

## Local prototyping

The `prototype` script invokes the real Flue workflow against a fixture issue and dumps the structured result. No GitHub writes — the orchestrator that does writes lives in the YAML.

```bash
cd .flue
pnpm install

# Cloudflare AI Gateway creds (same secrets bonk.yml and review.yml use)
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...
export CLOUDFLARE_API_KEY=...

# GitHub read-only token for the sandbox's `gh issue view`
export AGENT_GH_TOKEN=...  # or GITHUB_TOKEN / GH_TOKEN — the script picks any

# Run against a saved fixture (under .flue/fixtures/)
pnpm prototype 1021

# Or against a live issue
pnpm prototype --live 1183

# Try a different model
FLUE_INVESTIGATE_MODEL=cloudflare-ai-gateway/claude-sonnet-4-6 pnpm prototype 1021
```

The fixtures directory holds five real issues from the queue (#1021, #1042, #1046, #1049, #1080) so prompt iteration can happen without burning live `gh` API quota.

## One-time setup (when this lands on `main`)

1. **GitHub App.** The bot uses an existing App (the same one `bonk.yml`, `review.yml`, `release.yml`, `auto-format.yml` use). The `APP_ID` and `APP_PRIVATE_KEY` repository secrets already exist. The App's installation must include the `issues: write`, `contents: write`, and `pull_requests: write` permissions on `emdash-cms/emdash`.
2. **Labels.** `investigate.yml`'s first step does `gh label create --force` for each of the eight `bot:*` labels. No manual setup needed; the labels appear after the first run.
3. **GitHub Project board (optional).** Create a project in the UI with one column per `bot:*` label and a saved query like `repo:emdash-cms/emdash label:bot:reproducing` per column. The bot moves labels; cards follow automatically. Not required for the bot to function.

## What this PR does not do

- No Cloudflare Worker is deployed.
- No `app.ts`, no `wrangler.jsonc`.
- No `/repro` or `/verify` slash commands. Triggers are labels and comment replies only.
- No auto-fire on every new issue. The bot only runs when a maintainer explicitly requests it.
- No auto-merging or auto-PR-opening without reporter verification.
