# Review model evaluation results (2026-10-17)

The production review workflow (`.flue/workflows/review.ts` and the review skill, unchanged) run once per pull request head with three models, through the local harness in this directory. No GitHub App credentials were present, so nothing was posted. Each review saw what production sees: the PR title and description, the checked-out head and the diff against the merge base.

- **kimi**: `cloudflare/@cf/moonshotai/kimi-k2.7-code` over the Workers AI binding, the production model. Three runs at a time.
- **opus**: `anthropic/claude-opus-5-5` over AI Gateway, adaptive thinking at the API's default effort. Two runs at a time.
- **sol**: `openai/gpt-6.1-sol` over AI Gateway, default reasoning effort. Two runs at a time.

All 39 runs completed on the first attempt.

## Scoring

The cases and answer key are in `cases.json`, and per-run grades and notes in `grades.json`. Bot PRs are scored against the self-review answer key (K1 to K16). Human PRs are scored against a blind adversarial review of the same heads (H1 to H4), and four human PRs are clean. A key item scores 1 if a review found it clearly, 0.5 if it found part of it or raised and dismissed it, and 0 if it missed it. False claims are findings that are wrong or overstated at the reviewed head, checked against the code. A finding that a PR is sound when it is not counts as a miss, not a false claim. For verdicts, a clean PR should be approved and a PR with a should-fix defect should not. For the two PRs whose only defect is a nit (4167, 4150), either verdict is right, so they are left out of the verdict count.

## Per case

| PR   | Key items          | kimi score | kimi verdict | opus score | opus verdict | sol score      | sol verdict |
| ---- | ------------------ | ---------- | ------------ | ---------- | ------------ | -------------- | ----------- |
| 4226 | K1, K2, K3         | 1/3        | comment ✓    | 2/3        | comment ✓    | 2/3            | comment ✓   |
| 4225 | K4, K5, K15, K16   | 0/4        | comment ✓    | 0/4        | approve ✗    | 0/4            | approve ✗   |
| 4224 | K6, K7, K14        | 0/3        | approve ✗    | 0/3        | approve ✗    | 0/3            | approve ✗   |
| 4221 | K8, K9             | 0.5/2      | approve ✗    | 1/2        | approve ✗    | 0/2            | approve ✗   |
| 4201 | K10, K11, K12, K13 | 0/4        | approve ✗    | 1/4        | comment ✓    | 1/4            | comment ✓   |
| 4208 | H1                 | 0/1        | approve ✗    | 0/1        | approve ✗    | 0/1            | approve ✗   |
| 4128 | H2                 | 0/1        | approve ✗    | 0/1        | approve ✗    | 1/1            | comment ✓   |
| 4167 | H3 (nit)           | 1/1        | approve      | 1/1        | approve      | 1/1            | comment     |
| 4150 | H4 (nit)           | 0/1        | comment      | 1/1        | approve      | 0/1            | approve     |
| 4203 | clean              | clean      | approve ✓    | clean      | approve ✓    | clean          | approve ✓   |
| 4186 | clean              | clean      | approve ✓    | clean      | approve ✓    | clean          | approve ✓   |
| 4172 | clean              | clean      | approve ✓    | clean      | approve ✓    | clean, 1 false | comment ✗   |
| 4157 | clean              | clean      | approve ✓    | clean      | approve ✓    | clean          | approve ✓   |

What each model found:

- **4226**: all three found K1, that the route-cache fresh read only runs with an object cache. Opus and Sol also found K2, that the test sets `routeCacheFill` by hand and so cannot catch K1. Kimi praised that test instead. None found K3.
- **4225**: nobody found the widget-area race (K4) or the Durable Object SQL atomicity gap (K5). Opus noted that the Durable Object dialect takes the transaction fallback but did not see that the fallback is not atomic there. Kimi's `comment` verdict came from two minor suggestions, not from a defect.
- **4224**: all three approved and repeated the PR's "no migration needed" claim. K6, K7 and K14 were all missed.
- **4221**: Opus found K9 in full: `quality` leaks onto the `<img>` fallback and has no effect on the `getImage` path. It raised this as a suggestion and still approved. Kimi saw both halves of K9 and dismissed them as pre-existing. Nobody found K8.
- **4201**: Opus and Sol found K11, that the generated types omit `caption`. Kimi approved.
- **4128**: only Sol found H2, with a concrete reproduction: a draft translation with `taxonomies` clears the published source's group-level terms, and the removed purge leaves cached pages stale. Kimi and Opus accepted "drafts are not visible on public pages".
- **4208**: nobody found the same bug in media-usage discovery.
- **4167, 4150**: all three caught the issue reference in a comment (4167). Only Opus caught the changeset leaving out comments (4150).
- **4172**: no model repeated the production bot's false claim that awaiting the folded reads masks the error. Opus stated outright that the await cannot reject. Sol raised a needs-fixing finding that the folded reads now run before the migration-failure backoff check. That is true at this head, but it costs only extra reads during an error backoff window, so it is overstated as blocking and it turned a clean PR into a `comment`.

## Totals

| Model | Runs | Key score | Bot PRs | Human PRs | False claims | Verdicts right | Mean time | Mean tool calls | Mean tokens | Mean cost | Total cost |
| ----- | ---- | --------- | ------- | --------- | ------------ | -------------- | --------- | --------------- | ----------- | --------- | ---------- |
| kimi  | 13   | 2.5/20    | 1.5/16  | 1/4       | 0            | 6/11           | 11 min    | 36              | 1.82M       | $0.50     | $6.54      |
| opus  | 13   | 6/20      | 4/16    | 2/4       | 0            | 6/11           | 1.1 min   | 9               | 0.30M       | $0.31     | $3.98      |
| sol   | 13   | 5/20      | 3/16    | 2/4       | 1            | 6/11           | 1.1 min   | 10              | 0.47M       | $0.24     | $3.13      |

Time is the workflow's duration, including about 10 to 15 seconds to hydrate the repository. Kimi's times were measured with three concurrent runs; a single Kimi run of 4150 took 15 minutes. Tokens include cache reads. Costs are estimates from the recorded token usage at catalog rates: Kimi $0.95/$4 per million input/output tokens and $0.19 cache read; Opus 5.5 $4/$20, $0.20 cache read and $5 cache write; GPT-6.1 Sol $2/$10, $0.10 cache read and $2.50 cache write. Most of Kimi's cost is cache reads: it re-reads a growing context on each of about 36 tool calls a review.

## Observations

- With this workflow and skill, every model found few of the known defects: 2.5 to 6 of 20. The defects all three missed need the reviewer to look past the changed lines: sibling seed steps (K4), other storage backends (K5), data already stored in the old shape (K6, K14), the Cloudflare image endpoint (K8), and the same bug elsewhere (H1). The vendor models finished in about a minute with 5 to 13 tool calls and mostly approved. In the earlier `emdash-bot` replays, with a brief that framed the reported problem, Opus found K4 and K6.
- Kimi spends roughly 10 times the time and 4 to 6 times the tokens of the vendor models, and finds less.
- Verdict accuracy was 6 of 11 for every model. Every model approved all four clean PRs except Sol on 4172. Of the seven PRs with should-fix defects, each model correctly withheld approval on only two or three.
- No model repeated the production bot's 4172 false claim. Across 39 runs there was one overstated finding (Sol).

## Recommendation

Switching the review model to Claude Opus 5.5 would be cheaper and roughly ten times faster than Kimi, and it more than doubles the key findings (6 against 2.5 of 20) with no false claims. GPT-6.1 Sol is close (5 of 20) and the cheapest, but it made the one overstated finding and has the one wrong verdict on a clean PR. The model is not the main limit, though: no model came close to the answer key with the current brief. Before changing models, test whether giving the reviewer the linked issue and framing the review around the reported problem lifts recall; the variants below measure that. Treat these numbers as indicative: there is one run per case, and per-case results varied between runs in earlier replays.
