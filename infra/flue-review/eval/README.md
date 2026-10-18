# Review model evaluation

Runs the review workflow against fixed pull request heads with each candidate model, then records each review for grading against an answer key. It runs locally and never writes to GitHub.

## How it works

`run.ts` starts one `flue dev --target cloudflare` server per model. Each server runs from a scratch directory under `eval/.work/<model>` that links the package's own `.flue` sources and `node_modules`, so the reviewed code is exactly what production runs. The scratch directory's `wrangler.jsonc` differs from the package's in two ways: the Worker name, and the secrets that local development loads from `.dev.vars`. That file holds the model and AI Gateway settings and lists no GitHub App secrets, so they cannot load. The runner also refuses to start if `GITHUB_APP_*` is set in its environment, and strips `GITHUB_*` and `AI_GATEWAY_*` from the servers' environment.

Without GitHub App credentials the workflow reviews the given head once. It fetches the public tarball and diff unauthenticated, and skips the eyes reaction, check runs, prior-review and linked-issue fetches, head-move loop and posting. The runner fetches the issues each PR closes (title and body, no comments) with `gh` and passes them in the payload, so the context matches production.

`REVIEW_EVAL=1` mounts Flue's workflow and run routes under `/eval`, which the runner uses to start runs and read their results and events. Production sets no evaluation settings, so it serves neither route.

| Key     | Model                                      | Route                                       |
| ------- | ------------------------------------------ | ------------------------------------------- |
| `kimi`  | `cloudflare/@cf/moonshotai/kimi-k2.7-code` | Workers AI binding (the production default) |
| `opus`  | `anthropic/claude-opus-5-5`                | AI Gateway, Unified Billing                 |
| `sol`   | `openai/gpt-6.1-sol`                       | AI Gateway, Unified Billing                 |
| `panel` | Opus and Sol, merged by Sonnet             | AI Gateway, the production reviewer panel   |

The gateway models are not in the bundled Pi catalog, so `review-model.ts` wraps the stock Anthropic and OpenAI Responses protocols with the AI Gateway catalog's metadata for them (reasoning, pricing, adaptive thinking for Opus). The agent's thinking level (`medium`) then reaches the request as adaptive thinking with `effort: medium` for Opus, and `reasoning.effort: medium` with encrypted reasoning carried across turns for Sol. Both get the same 262,144-token context budget as Kimi, so compaction behaves the same. The runner prices usage from its own table, using the AI Gateway catalog rates.

## Running

The gateway models need `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_NAME` and `AI_GATEWAY_TOKEN`, read from a dotenv file passed with `--gateway-env`, or from the environment. `gh` must be signed in; it reads PR titles, bodies and refs, and the merge base of each head.

```sh
node eval/run.ts --gateway-env /path/to/.env
node eval/run.ts --models opus --cases 4150,4208 --gateway-env /path/to/.env
```

| Option           | Default         | Meaning                                                       |
| ---------------- | --------------- | ------------------------------------------------------------- |
| `--models`       | `kimi,opus,sol` | Model keys. Each model runs on its own server, in parallel.   |
| `--cases`        | all             | Comma-separated PR numbers from `cases.json`.                 |
| `--concurrency`  | `1`             | Concurrent runs per model.                                    |
| `--base-port`    | `3591`          | First server port; later models take the next ports.          |
| `--timeout-min`  | `45`            | Per-run timeout.                                              |
| `--force`        | off             | Re-run cases that already have a completed result.            |
| `--label`        | none            | Extra result-file suffix, to keep repeat runs apart.          |
| `--reviewers`    | Opus,Sol        | `panel` only: the `REVIEW_MODELS` list.                       |
| `--merge-model`  | Sonnet          | `panel` only: the `REVIEW_MERGE_MODEL`.                       |
| `--head`         | the case's head | Review this head instead; needs exactly one case.             |
| `--prior-head`   | none            | With `--prior-result`: run a scoped follow-up from this head. |
| `--prior-result` | none            | Result file whose review is the prior-review context.         |

A failed run is retried once. Unauthenticated GitHub API calls are limited to 60 an hour per IP and each run spends two, so the runner waits for the allowance to reset when it runs low.

Results go to `eval/results/<pr>-<model>.json`, or `<pr>-<model>-<label>.json` (gitignored): the `ReviewResult`, status, wall time, workflow duration, token usage and estimated cost. Server logs go to `eval/results/logs/`, and each run's Flue event stream to `eval/results/events/`.

## Cases and grading

`cases.json` holds each PR, the head to review and an answer key: the known defects with their severities, whether the PR is clean, the expected verdict, and any known false claims. A clean PR should be approved, and a PR with a should-fix defect should not.

Each key item scores 1 when a review finds it clearly, 0.5 when it finds part of it or raises and dismisses it, and 0 when it misses it. False or overstated claims are counted separately, checked against the code at the reviewed head. `RESULTS.md` records the latest graded run.

`grades.json` holds the grades, keyed by variant, PR and model. `node eval/summarize.ts [variant] [models] [cases]` prints the per-case and totals tables from the grades and raw results.

## Panel runs

The `panel` key runs the production configuration: each reviewer in its own session, then the merge. The server log in `eval/results/logs/` has one `reviewer finished` line per reviewer (model, outcome, error class, tokens, cost, duration) and a `review merge path` line (`merged`, `fallback` or `single_reviewer`). The recorded cost covers the reviewers; the merge cost is in its log line. To see the single-reviewer path, pass a reviewer that cannot complete, for example `--reviewers anthropic/claude-opus-5-5,openai/not-a-model`.

To run a scoped follow-up review, pass a later head and the earlier review: `--head <sha>` overrides the case's head, `--prior-head <sha>` names the last reviewed head, and `--prior-result <file>` is an earlier result file whose review becomes the prior-review context. The runner fetches the diff between the heads with `gh`, and the log's `review scope filter` line counts the suggestions dropped outside the change and the `needs_fixing` findings marked as missed earlier.

The results in `RESULTS.md` under "Variants" were run with an earlier `--variant` option, before the linked issue and the framing became part of production.

## Merging reviews

`.flue/lib/review-merge.ts` merges independent reviews of one head. `node --import ./eval/ts-resolve.mjs eval/merge.ts --gateway-env <file> [--mergers haiku,sonnet,luna]` merges each Opus and Sol issue+framing pair from `eval/results` offline, with each merge model and the deterministic fallback, and writes `eval/results/merge/<pr>-<label>-<merger>.json`. `ts-resolve.mjs` lets Node load the `.flue` modules, which import siblings by `.js` names.
