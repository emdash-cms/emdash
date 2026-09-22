# Investigation-bot evals

An operator tool that drives the **deployed** emdash-bot worker's investigate
agent against a curated set of closed issues and scores each verdict against
recorded ground truth. It is the pre-flight gate for the big-bang cutover: the
one number that must be zero is **confident-wrong** — a reproduction asserted on
an issue that has nothing to reproduce.

This cannot run in CI. It needs live Cloudflare bindings (Durable Objects,
Workers AI, the Sandbox container) and a deployed worker, and each case runs a
real container (clone → inspect → reproduce), which takes minutes. The pure
pieces — dataset loading, pre-fix SHA resolution, scoring, formatting — are
unit-tested in `tests/unit/evals-*.test.ts` and do run in CI.

## What it does

For each case the runner:

1. reads the issue's title/body from GitHub (read-only),
2. dispatches an `investigate` run in **diagnose** mode to the worker's
   token-gated `/agents/investigate/:id` surface, standing the workspace up at
   the case's checkout ref,
3. polls the conversation snapshot until the agent reports a verdict,
4. scores that verdict against the case's ground truth.

**Checkout ref.** A confirmed-bug case checks out the **pre-fix commit** — the
first parent of the fixing PR's merge commit, recorded in `dataset.json` — so
the bug is actually present. Negative cases (not-reproducible, needs-info) check
out `main`, where a correct investigation should fail to reproduce or ask for
information. The ref is passed as the agent's `baseRef`; `cloneRepo` and the
container checkout resolve a branch, tag, or bare commit SHA uniformly.

## Scoring

Diagnose-mode outcome mirrors the machine's `outcomeFromResult`
(`reproduced` / `diagnosed` / `not_reproduced` / `needs_info` / `by_design` /
`skipped` / `failed`). Per category:

| Category           | Pass                                                           | Confident-wrong (the gate) |
| ------------------ | -------------------------------------------------------------- | -------------------------- |
| `CONFIRMED_BUG`    | `reproduced` **and** the summary names a known fault-area term | —                          |
| `NOT_REPRODUCIBLE` | `not_reproduced` (with transcript)                             | `reproduced`               |
| `NEEDS_INFO`       | `needs_info`                                                   | `reproduced`               |

A confirmed bug where the agent names the fault area with `rootCauseFound` but
no confirming reproduction grades **diagnosed** — counted separately from both
pass and miss. A `diagnosed` claim on a negative case is a miss, not
confident-wrong: it is hedged, and the fix loop would still demand a failing
test before changing anything.

- A confirmed bug that the agent fails to reproduce is a **miss** (false
  negative), never confident-wrong.
- Asserting a reproduction on a negative case is **confident-wrong** — the gate
  bars any of these.
- A case the harness could not get a verdict for (dispatch/timeout/no result) is
  an **error**, an infra failure to fix and re-run. Errors also fail the gate.

The gate passes only with **zero confident-wrong and zero errors**.

## Usage

```sh
pnpm evals -- --case 917               # one case
pnpm evals -- --case 917 --case 895    # several
pnpm evals -- --category not_reproducible
pnpm evals -- --all
```

### Environment

| Variable      | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `WORKER_URL`  | Base URL of the deployed bot worker                                 |
| `ADMIN_TOKEN` | Bearer token for `/agents/*` (the worker's `GITHUB_WEBHOOK_SECRET`) |
| `GH_TOKEN`    | GitHub token to read issue titles/bodies (read-only)                |
| `REPO`        | `owner/name` to investigate (default `emdash-cms/emdash`)           |
| `TIMEOUT_MS`  | Per-case verdict timeout (default 1800000 = 30 min)                 |
| `POLL_MS`     | Snapshot poll interval (default 15000)                              |

Results print as a table plus a gate banner and are written to
`evals/results/<timestamp>.json` (gitignored). The process exits non-zero if the
gate fails.

## Safety

Diagnose-mode runs never push a fix or open a PR. Point the harness at a
**staging** worker. With no GitHub App credentials configured on that worker the
run is fully read-only: a public clone, isolate/container analysis, and a verdict
in the agent's data stream — the result callback into the issue's Durable Object
is a stale-run no-op because the eval dispatches the agent directly rather than
through the issue's DO.

## Dataset

`dataset.json` — 26 curated closed issues (18 confirmed bugs, 4
not-reproducible, 4 needs-info). Each confirmed-bug case carries `fault_anchors`
(fault-area terms a correct diagnosis should name) and, when the bug has been
fixed, `pre_fix` (the fixing merge commit + its parents) so the run checks out
the pre-fix commit; an unfixed confirmed bug (`fixing_pr: null`, e.g. #1193)
runs at `main`, where the bug is still live. See `dataset.md` for the
human-readable rationale and per-case notes.

## Implementation delivery smoke

The diagnose corpus does not exercise writes. Before cutting over a publisher,
run the full implementation smoke against a staging worker configured for a
disposable repository and issue containing a deterministic fixture-edit task.
Set the staging Worker's `PREVIEW_PACKAGE` variable to the pkg.pr.new package
path that repository's preview workflow publishes; this keeps its readiness
probe isolated from production previews.

```sh
ALLOW_GITHUB_WRITES=1 \
WORKER_URL=https://emdash-bot-staging.example.workers.dev \
ADMIN_TOKEN=... GH_TOKEN=... REPO=owner/disposable-repo \
ISSUE_NUMBER=123 SMOKE_ACTOR=maintainer-login \
DIRECTIVE='Update the implementation-canary fixture as this issue specifies' \
pnpm evals:implementation
```

The test sends signed webhook commands through the real orchestrator and
requires all of these outcomes: candidate branch creation, a changed remote
SHA, preview readiness (`bot:awaiting-reporter`), reporter confirmation, and a
draft PR. It deliberately leaves the draft PR and branch for inspection. It
refuses `emdash-cms/emdash` unless `ALLOW_PRODUCTION_REPO=1` is also set.
