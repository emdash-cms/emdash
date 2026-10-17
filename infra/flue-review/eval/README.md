# Review model evaluation

Runs the review workflow against fixed pull request heads with each candidate model, then records each review for grading against an answer key. It runs locally and never writes to GitHub.

## How it works

`run.ts` starts one `flue dev --target cloudflare` server per model. Each server runs from a scratch directory under `eval/.work/<model>` that links the package's own `.flue` sources and `node_modules`, so the reviewed code is exactly what production runs. The scratch directory's `wrangler.jsonc` differs from the package's in two ways: the Worker name, and the secrets that local development loads from `.dev.vars`. That file holds the model and AI Gateway settings and lists no GitHub App secrets, so they cannot load. The runner also refuses to start if `GITHUB_APP_*` is set in its environment, and strips `GITHUB_*` and `AI_GATEWAY_*` from the servers' environment.

Without GitHub App credentials the workflow reviews the given head once. It fetches the public tarball and diff unauthenticated, and skips the eyes reaction, check runs, prior-review fetch, head-move loop and posting.

`REVIEW_EVAL=1` mounts Flue's workflow and run routes under `/eval`, which the runner uses to start runs and read their results and events. Production sets no evaluation settings, so it serves neither route.

| Key | Model | Route |
| --- | --- | --- |
| `kimi` | `cloudflare/@cf/moonshotai/kimi-k2.7-code` | Workers AI binding (the production default) |
| `opus` | `anthropic/claude-opus-5-5` | AI Gateway, Unified Billing |
| `sol` | `openai/gpt-6.1-sol` | AI Gateway, Unified Billing |

The gateway models are not in the bundled Pi catalog, so Flue treats them as non-reasoning models with no pricing. Claude Opus 5.5 thinks adaptively when no thinking setting is sent, and GPT-6.1 Sol reasons at its default effort. Their responses are stored server-side so reasoning items can be replayed across tool turns. Both get the same 262,144-token context budget as Kimi, so compaction behaves the same. The runner prices usage from its own table, using the AI Gateway catalog rates.

## Running

The gateway models need `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_NAME` and `AI_GATEWAY_TOKEN`, read from a dotenv file passed with `--gateway-env`, or from the environment. `gh` must be signed in; it reads PR titles, bodies and refs, and the merge base of each head.

```sh
node eval/run.ts --gateway-env /path/to/.env
node eval/run.ts --models opus --cases 4150,4208 --gateway-env /path/to/.env
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--models` | `kimi,opus,sol` | Model keys. Each model runs on its own server, in parallel. |
| `--cases` | all | Comma-separated PR numbers from `cases.json`. |
| `--concurrency` | `1` | Concurrent runs per model. |
| `--base-port` | `3591` | First server port; later models take the next ports. |
| `--timeout-min` | `45` | Per-run timeout. |
| `--force` | off | Re-run cases that already have a completed result. |

A failed run is retried once. Unauthenticated GitHub API calls are limited to 60 an hour per IP and each run spends two, so the runner waits for the allowance to reset when it runs low.

Results go to `eval/results/<pr>-<model>.json` (gitignored): the `ReviewResult`, status, wall time, workflow duration, token usage and estimated cost. Server logs go to `eval/results/logs/`.

## Cases and grading

`cases.json` holds each PR, the head to review and an answer key: the known defects with their severities, whether the PR is clean, the expected verdict, and any known false claims. A clean PR should be approved, and a PR with a should-fix defect should not.

Each key item scores 1 when a review finds it clearly, 0.5 when it finds part of it or raises and dismisses it, and 0 when it misses it. False or overstated claims are counted separately, checked against the code at the reviewed head. `RESULTS.md` records the latest graded run.
