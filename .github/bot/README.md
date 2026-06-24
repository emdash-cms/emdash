# emdashbot orchestration

This directory is the orchestration layer for the issue/PR automation bot. It
owns *which state an item is in and how it moves*. It does **not** own how the
agent reproduces, diagnoses, or fixes -- that is `.flue/`, invoked here as an
opaque action.

## Files

| File                   | Role                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| `machine.ts`           | **Single source of truth.** States, events, actors, transitions.     |
| `machine.json`         | Generated runtime artifact loaded by the workflows. Do not hand-edit. |
| `../BOT_STATE_MACHINE.md` | Generated docs: diagram, state/transition tables, command grammar. |
| `generate.ts`          | `machine.ts` -> `machine.json` + docs. `--check` mode for CI.         |
| `router.cjs`           | Pure transition logic (no GitHub calls). Consumed by `github-script`. |
| `router.test.cjs`      | `node --test` unit tests for the router.                              |

Regenerate after editing the spec:

```bash
pnpm bot:generate        # writes machine.json + BOT_STATE_MACHINE.md
node --test .github/bot/router.test.cjs
```

CI runs `pnpm bot:generate --check` and fails if the artifacts drift, the same
contract as the query-count snapshots.

## Architecture

```
machine.ts ──generate──> machine.json ──require──> router.cjs (pure)
                                                        │
        thin event workflows ───────────────────────────┤
          • control-listener  (issue/PR comments: @emdashbot grammar)
          • system-events     (label add, PR opened/merged/reviewed, agent results)
          • bot-linter        (invariant: exactly one kind + one state)
                                                        │
                                                        ▼
                                            router.resolve(labels, event)
                                                        │
                              ┌─────────────────────────┼───────────────────────┐
                              ▼                          ▼                       ▼
                       swap state label         dispatch agent action      post reply
                       (atomic remove+add)       (existing investigate.yml)  (+ command footer)
```

The router is the brain; the workflows are hands. A workflow gathers the event,
asks `router.resolve(...)` what to do, and performs the GitHub writes. All the
state logic lives in one tested module instead of being spread across the `if:`
guards and bash label-flips of six workflows.

## How the existing agent plugs in (internals untouched)

The agent (`.flue/workflows/investigate.ts`) keeps its exact contract. We change
only *how it is triggered* and *how its result maps to the next state* -- and that
mapping moves out of bash and into the transition table:

| Agent result (flat gating fields)        | Event fired        | Lands in            |
| ----------------------------------------- | ------------------ | ------------------- |
| `skipped === true`                        | `agent.skipped`    | `blocked`           |
| `!skipped && !reproduced`                 | `agent.not_reproduced` | `blocked`       |
| `verdict === "intended-behavior"`         | `agent.by_design`  | `blocked`           |
| `reproduced && !fixed`                    | `agent.reproduced` | `blocked`           |
| `reproduced && fixed`                     | `agent.fix_ready`  | `awaiting_feedback` |
| nonzero exit / no result file             | `agent.failed`     | `failed`            |

Action ids map to the agent's existing entry modes:

| Action                 | How it invokes the unchanged agent                                  |
| ---------------------- | ------------------------------------------------------------------- |
| `investigate.repro`    | dispatch with `{ issueNumber }`                                     |
| `investigate.implement`| dispatch with `{ issueNumber, maintainerDirective }` (existing flag)|
| `investigate.revise`   | dispatch with `{ issueNumber, retryContext }` (existing flag)       |
| `openPr` / `closePr`   | `gh pr create` / `gh pr close` (no agent run)                       |

`investigate.implement` and `investigate.revise` reuse `maintainerDirective` /
`retryContext`, which the agent already supports. The only genuinely new entry
is `revise` from `in_review` checking out the existing `bot/fix-<n>` branch.

## Two interface rules worth calling out

- **Entry needs no triage.** `@emdashbot implement <directive>` (and `repro`,
  `decline`) work on an issue with no bot labels at all -- the `unmanaged` start
  state. There is no "triage it first" step; the command both files the item
  into the machine and acts. `triage` only exists as the labeled resting place
  something lands in after `reopen` or `hand back`.
- **Bot PRs take plain feedback.** While `in_review` on a bot-authored PR, an
  `@emdashbot` comment whose verb isn't recognized is treated as `revise`, with
  the whole comment as the feedback. Reviewers don't need the `revise` keyword.
  The `@emdashbot` mention is still required, so ordinary PR discussion stays
  inert, and explicit verbs (`take over`, `decline`, ...) still win. The listener
  passes `allowDefault: true` only for bot-authored PRs; `router.resolveComment`
  applies the rule. Because a revise run moves the item to the transient
  `working` state, comments arriving mid-run are status no-ops until it returns
  to `in_review`, which debounces a fast back-and-forth into one run at a time.

## What's built

- **`machine.ts` + generated artifacts + `router.cjs` (+ tests).** The spec, the
  runtime JSON, and the pure transition logic, including `outcomeFromResult`
  (agent result -> `agent.*` event) and `resolveComment` (the `@emdashbot`
  grammar with the bot-PR implicit-`revise` rule).
- **`.flue/` migrated to Flue 1.0** (`@flue/runtime@1.0.0-beta.5`): the
  investigate workflow (one agent, separate `classify`/`fix` sessions with model
  overrides), and the two classifier workflows, all on `defineWorkflow`/
  `defineAgent`. `flue build --target node` passes.
- **`.github/workflows/orchestrate.yml`** — the brain: events -> route
  (deterministic) -> classify (only for free-text replies) -> `resolve` ->
  label flip + comment -> `repository_dispatch` the agent run.
- **`.github/workflows/investigate-run.yml`** — the executor: `flue run
  investigate` on a runner (the toolchain) -> push `bot/fix-<n>` if fixed ->
  `outcomeFromResult` + `resolve` -> apply the transition. The agent only ever
  holds the read-only `AGENT_GH_TOKEN`; every write uses the app token.

## Cutover plan

Everything ships gated behind the `BOT_STATE_MACHINE_V2` repo variable, so the
live bot is untouched until it is flipped.

1. **Foundation (done).** Spec, artifacts, router + tests, CI drift check,
   read-only linter, the Flue 1.0 agent migration. No behavior change.
2. **Shadow.** Run `orchestrate.yml` in log-only mode (compute decisions,
   annotate) alongside the live workflows. Compare against
   `reporter-reply.yml` / `maintainer-reply.yml` / `investigate.yml`.
3. **Cut over.** Flip `BOT_STATE_MACHINE_V2`. `orchestrate.yml` +
   `investigate-run.yml` own the writes; retire `reporter-reply.yml`,
   `maintainer-reply.yml`, and the orchestration (not the agent run) parts of
   the old `investigate.yml`. Migrate live labels (`triage/* -> bot:*`) with a
   one-shot backfill (map below).
4. **New edges.** The gap-closing edges (`blocked -> implement`,
   `in_review -> revise`, the enhancement lane, terminal `reopen`) are already
   in the table and just work.

### Label migration map

| Old                          | New                    |
| ---------------------------- | ---------------------- |
| `triage/reproducing`         | `bot:working`          |
| `triage/reproduced`          | `bot:blocked`          |
| `triage/by-design`           | `bot:blocked`          |
| `triage/skipped`             | `bot:blocked`          |
| `triage/not-reproduced`      | `bot:blocked`          |
| `triage/failed`              | `bot:failed`           |
| `triage/awaiting-reporter`   | `bot:awaiting-feedback`|
| `triage/verified`            | `bot:in-review`        |
| (none / `bot:repro` trigger) | `bot:triage` + command |

The `review/*` PR labels stay as in-review sub-states on the PR; they roll up to
`bot:in-review` on the anchoring issue.
