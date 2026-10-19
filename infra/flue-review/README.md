# Flue PR reviewer

A Cloudflare Worker that reviews pull requests on `emdash-cms/emdash` as `emdashbot[bot]`. The GitHub App webhook in `.flue/app.ts` admits a review, and the workflow in `.flue/workflows/review.ts` checks out the PR head, runs the review skill with each configured reviewer model, merges their reviews, and posts one review.

## When a PR is reviewed

- **Opened, reopened or marked ready for review**: a full review. Drafts, design PRs and PRs from bots other than `emdashbot` and `emdash-autofix` are skipped.
- **`bot:review` label**: a full review of the current head, straight away. Use it to force a review at any time, including past the automatic re-review limit.
- **A push by `emdash-autofix` to its own PR**: a full review, straight away.
- **Any other push to a PR the bot has reviewed before**: an automatic follow-up review once CI on the new head has finished. The `ReReviewScheduler` Durable Object, one per PR, polls the head's check runs every 2 minutes. It reviews once every check run has completed on two polls in a row, once 10 minutes pass with no check runs at all, or after 60 minutes regardless. It always works on the PR's current head, so a push superseded while its CI ran is never reviewed, and each head is reviewed at most once. It skips the head when the change since the last reviewed head is only the bot's formatting commits or only a merge of the base branch, waits while an earlier automatic re-review is still running, and stops after `REVIEW_AUTO_REREVIEW_LIMIT` automatic re-reviews of the PR in 24 hours.

A follow-up of a large change, more than `REVIEW_FOLLOWUP_MAX_LINES` added and deleted lines between the two heads in the PR's files, gets a full panel review instead, with the earlier review as context, and the footer says so. Otherwise a follow-up review is scoped to what changed, and with the AI Gateway it runs a single reviewer, `REVIEW_FOLLOWUP_MODELS` (GPT-6.1 Sol by default), with no merge step. If it fails, the run fails like any other review; the `bot:review` label then forces a full review with the panel. The reviewer gets the earlier review with the author's replies and the diff between the two heads, and is asked to check whether each earlier finding was addressed or reasonably answered and whether the new changes introduce a defect, not to look for new issues in unchanged code. Trusted code then drops any suggestion anchored outside the lines that changed between the heads, keeps a `needs_fixing` finding outside them with a note that the earlier review missed it, and approves when no `needs_fixing` finding remains.

Every review keeps all `needs_fixing` findings and at most `REVIEW_MAX_SUGGESTIONS` suggestions, in the merged order.

## Review labels and GitHub rate limits

When a person submits or dismisses a review on an open, ready PR, the webhook removes and re-adds the PR's `review/*` label (or adds `review/needs-review` when it has none). The `labeled` event runs `.github/workflows/approval.yml` from `main`, which recalculates the label and the `Human Maintainer approval` check. The workflow doesn't trigger on reviews itself, because a review event would run the PR branch's copy of it. Reviews by bots are ignored, since the workflow counts only reviews by people.

Every GitHub request goes through the `GitHubRateLimitDO` Durable Object, one per App installation. It caches the installation token, paces requests from GitHub's rate-limit headers, and holds every caller back after a 403 or 429 until the limit resets.

The webhook needs the `pull_request` and `pull_request_review` events.

## Reviewers

Each reviewer runs the review skill independently, in parallel, on the same checked-out head with the same context: the PR title and description, any issues the PR says it closes (title and body only), the accepted design proposals it links, and the bot's previous review on a re-review. A tool-less merge model then combines the completed reviews into one, and trusted code checks every anchor and decides the verdict. The posted review ends with a footer naming the reviewers and whether one was unavailable.

| Setting                      | Default                                        | Meaning                                                                                                            |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `REVIEW_MODELS`              | `anthropic/claude-opus-5-5,openai/gpt-6.1-sol` | Comma-separated reviewer model IDs. Read only when the AI Gateway secrets are set.                                 |
| `REVIEW_MERGE_MODEL`         | `anthropic/claude-sonnet-5-5`                  | Gateway model that merges two or more reviews, at low reasoning effort.                                            |
| `REVIEW_FOLLOWUP_MODELS`     | `openai/gpt-6.1-sol`                           | Comma-separated reviewer model IDs for automatic follow-up reviews. Read only when the AI Gateway secrets are set. |
| `REVIEW_FOLLOWUP_MAX_LINES`  | `1000`                                         | A follow-up with more changed lines than this gets a full panel review.                                            |
| `REVIEW_MAX_SUGGESTIONS`     | `3`                                            | Suggestions kept per review.                                                                                       |
| `REVIEW_AUTO_REREVIEW_LIMIT` | `5`                                            | Automatic re-reviews per PR in 24 hours. The `bot:review` label is not limited.                                    |

Without the AI Gateway secrets, Kimi K2.7 Code reviews alone over the Workers AI binding, with no merge and no footer.

If one reviewer fails, the review from the other is posted with a note that a reviewer was unavailable. The run fails only when no reviewer completes. If the merge model fails or returns invalid output, the reviews are combined deterministically instead. Rate limit and overload responses from Workers AI, AI Gateway, Anthropic and OpenAI (429, 529, and 503 overloaded) are retried with backoff.

## Secrets

| Secret                   | Required | Purpose                                                          |
| ------------------------ | -------- | ---------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`  | Yes      | Verifies webhook deliveries and protects `/webhook/admin/runs`.  |
| `GITHUB_APP_PRIVATE_KEY` | Yes      | Mints installation tokens (PKCS#8 PEM).                          |
| `AI_GATEWAY_ACCOUNT_ID`  | No       | Cloudflare account that owns the AI Gateway.                     |
| `AI_GATEWAY_NAME`        | No       | AI Gateway name.                                                 |
| `AI_GATEWAY_TOKEN`       | No       | AI Gateway token, with Unified Billing for Anthropic and OpenAI. |

Set each with `wrangler secret put <NAME>`. All three `AI_GATEWAY_*` secrets must be set to enable the gateway reviewers.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

`eval/` runs the workflow locally against fixed PR heads without GitHub credentials; see [eval/README.md](eval/README.md).
