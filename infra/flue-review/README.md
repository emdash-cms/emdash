# Flue PR reviewer

A Cloudflare Worker that reviews pull requests on `emdash-cms/emdash` as `emdashbot[bot]`. The GitHub App webhook in `.flue/app.ts` admits a review, and the workflow in `.flue/workflows/review.ts` checks out the PR head, runs the review skill with each configured reviewer model, merges their reviews, and posts one review.

## Reviewers

Each reviewer runs the review skill independently, in parallel, on the same checked-out head with the same context: the PR title and description, any issues the PR says it closes (title and body only), the accepted design proposals it links, and the bot's previous review on a re-review. A tool-less merge model then combines the completed reviews into one, and trusted code checks every anchor and decides the verdict. The posted review ends with a footer naming the reviewers and whether one was unavailable.

| Setting              | Default                                        | Meaning                                                                            |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `REVIEW_MODELS`      | `anthropic/claude-opus-5-5,openai/gpt-6.1-sol` | Comma-separated reviewer model IDs. Read only when the AI Gateway secrets are set. |
| `REVIEW_MERGE_MODEL` | `anthropic/claude-sonnet-5-5`                  | Gateway model that merges two or more reviews, at low reasoning effort.            |

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
