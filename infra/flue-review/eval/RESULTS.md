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

## Variants: linked issue and review framing

Two eval-only context variants, run on the five bot PRs with Opus and Sol. Each is gated by `REVIEW_CONTEXT_VARIANT`, which production never sets.

- **issue**: the issue each PR says it resolves (title and body, no comments), fetched by the runner and rendered as an untrusted "Linked issue" section after the description. Production passes only the PR text, although the review skill says the linked issue is among its inputs.
- **issue+framing**: the issue, plus an instruction to apply first, before enumerating candidates: establish whether the change fixes what was reported in the reporter's situation and on their path; whether every claim in the title, description and changeset is true; whether the same problem exists elsewhere (sibling call sites, other backends, data already stored in the old shape); and what the tests prove and cannot catch.

One run per case. The variants ran with eight reviews at a time, so their times are slightly inflated.

| PR (key items)          | Opus baseline | Opus issue | Opus issue+framing | Sol baseline | Sol issue | Sol issue+framing |
| ----------------------- | ------------- | ---------- | ------------------ | ------------ | --------- | ----------------- |
| 4226 (K1–K3)            | 2 ✓           | 2 ✓        | 3 ✓                | 2 ✓          | 2 ✓       | 2 ✓               |
| 4225 (K4, K5, K15, K16) | 0 ✗           | 0 ✗        | 0.5 ✗              | 0 ✗          | 0 ✗       | 0 ✗               |
| 4224 (K6, K7, K14)      | 0 ✗           | 0 ✗        | 2 ✓                | 0 ✗          | 2 ✓       | 1 ✓               |
| 4221 (K8, K9)           | 1 ✗           | 1 ✗        | 1 ✓                | 0 ✗          | 0 ✗       | 0 ✗               |
| 4201 (K10–K13)          | 1 ✓           | 0 ✗        | 1 ✓                | 1 ✓          | 1 ✓       | 1 ✓               |
| **Key score (of 16)**   | **4**         | **3**      | **7.5**            | **3**        | **5**     | **4**             |
| False claims            | 0             | 0          | 0                  | 0            | 0         | 0                 |
| Verdicts right (of 5)   | 2             | 1          | 4                  | 2            | 3         | 3                 |
| Mean tool calls         | 11            | 11         | 13                 | 11           | 11        | 13                |
| Mean tokens             | 0.36M         | 0.33M      | 0.47M              | 0.61M        | 0.67M     | 0.76M             |
| Mean time               | 1.3 min       | 1.3 min    | 1.7 min            | 1.3 min      | 1.4 min   | 1.6 min           |
| Mean cost               | $0.34         | $0.33      | $0.43              | $0.28        | $0.31     | $0.31             |

✓ and ✗ mark whether the verdict was right; every PR here has a should-fix defect, so approving is wrong.

- **Opus with framing** nearly doubled its key findings (7.5 against 4) and got 4 of 5 verdicts right, for about $0.09 more a review. On 4224 it found K6 and K14: rows already stored under a code become unreachable, and re-applying a seed creates a duplicate row. On 4226 it found K3 for the first time in any run: expiry drops the snapshot before the refresh, so a failed refresh errors, and it suggested stale-while-revalidate. On 4221 it withheld approval over K9, which it had found every time but had approved past.
- **The issue alone did not help Opus** (3 against 4): it tied K1 to the reporter's setup on 4226, but it approved 4201 without K11, which it found in the baseline. With one run per case, the difference is within run-to-run noise.
- **Sol gained from the issue** (5 against 3), all of it on 4224, where the issue text names code-stamped rows; the framing added nothing further (4). Sol still approved 4225 and 4221 in every variant.
- **Still missed by every run**: K4 (the widget-area race), K7, K8, K10, K12, K13, K15 and K16. K5 came closest, with a dismissed half (Opus with framing, on the REST D1 dialect rather than Durable Object SQL).
- No variant introduced a false claim.

With the framing and the linked issue in the context, Opus is the strongest reviewer measured here: 7.5 of 16 against Kimi's 1.5 on the same five PRs in the baseline, at a fraction of Kimi's time. These are single runs on five PRs, so the next step is repeat runs, and the clean and human PRs under the framing variant, to check that the framing does not raise false alarms there before it reaches production.

## Reasoning settings

The runs above predate a fix: the bundled catalog does not know Claude Opus 5.5 or GPT-6.1 Sol, so Flue built them as non-reasoning models and sent no thinking or reasoning settings. Opus 5.5 still thinks adaptively at its default `medium` effort when the setting is absent, and Sol reasons at its default, so the effect was mainly that thinking was not summarized and Sol's reasoning was not carried across turns. `review-model.ts` now restores the catalog metadata, so the agent's `medium` thinking level is sent: `thinking: { type: "adaptive" }` with `output_config.effort: "medium"` for Opus, and `reasoning: { effort: "medium" }` with `include: ["reasoning.encrypted_content"]` for Sol (asserted in `test/review-model.test.ts`). In a live run, every turn reported `reasoningLevel: "medium"`. Opus returned 13 summarized thinking blocks and 4,309 reasoning tokens, and Sol 11 reasoning summaries and 1,190 reasoning tokens.

PR 4224 with issue+framing, reasoning on, two runs each, against the earlier run without reasoning settings (K6, K7, K14; 3 points):

| Run                         | Key items   | Verdict           | False claims | Tool calls | Tokens (output, reasoning) | Time  | Cost  |
| --------------------------- | ----------- | ----------------- | ------------ | ---------- | -------------------------- | ----- | ----- |
| Opus, no reasoning settings | K6, K14 (2) | comment ✓         | 0            | 17         | 0.68M (8.6k, not recorded) | 137 s | $0.56 |
| Opus, reasoning, run 1      | K6 (1)      | comment ✓         | 0            | 17         | 0.68M (8.8k, not recorded) | 127 s | $0.57 |
| Opus, reasoning, run 2      | none (0)    | approve ✗         | 0            | 15         | 0.59M (8.7k, 4.3k)         | 117 s | $0.43 |
| Sol, no reasoning settings  | K6 (1)      | request_changes ✓ | 0            | 18         | 1.29M (3.6k, not recorded) | 126 s | $0.44 |
| Sol, reasoning, run 1       | K6 (1)      | request_changes ✓ | 0            | 17         | 1.23M (3.5k, not recorded) | 134 s | $0.44 |
| Sol, reasoning, run 2       | K6 (1)      | request_changes ✓ | 0            | 16         | 1.23M (3.5k, 1.2k)         | 120 s | $0.47 |

Output tokens, tool calls and cost barely moved, which fits both models already reasoning at medium effort. Sol was consistent across all three runs. Opus varied from 2 key items to an approval on the same inputs, so single runs of Opus are noisy, and the variant comparison above needs repeat runs before it is trusted. Reasoning tokens were recorded only once the runner began saving event streams.

## Variance (issue+framing, reasoning on)

Three runs per bot PR and one per human PR, for Opus and Sol, with the linked issue and framing variant and reasoning on. Two of the three 4224 runs per model are the reasoning runs above (same setup). None of the human PRs closes an issue, so their context had the framing but no "Linked issue" section; the event streams confirm this. Grades are under `issue+framing-v1` to `-v3` in `grades.json`.

Key score per bot PR, as the mean and range over three runs:

| PR (key items)                      | Opus          | Sol         |
| ----------------------------------- | ------------- | ----------- |
| 4226 (3)                            | 2.2 (2–2.5)   | 2 (2–2)     |
| 4225 (4)                            | 0.7 (0–1)     | 0 (0–0)     |
| 4224 (3)                            | 1 (0–2)       | 1 (1–1)     |
| 4221 (2)                            | 1 (1–1)       | 0 (0–0)     |
| 4201 (4)                            | 0.5 (0–1)     | 1 (1–1)     |
| **Total (16)**                      | **5.3 (4–7)** | **4 (4–4)** |
| Runs that missed everything on a PR | 3 of 15       | 6 of 15     |
| Bot verdicts right                  | 12 of 15      | 9 of 15     |

Human PRs, one run each:

|                                                    | Opus   | Sol    |
| -------------------------------------------------- | ------ | ------ |
| Key score (4)                                      | 2.5    | 2      |
| Verdicts right (4208, 4128 and the four clean PRs) | 3 of 6 | 4 of 6 |
| False or overstated claims                         | 1      | 1      |
| Clean PRs approved                                 | 3 of 4 | 3 of 4 |

|           | Opus    | Sol     |
| --------- | ------- | ------- |
| Mean time | 1.5 min | 1.4 min |
| Mean cost | $0.42   | $0.30   |

- **Opus varies from run to run**: 4 to 7 of 16, and on single PRs from nothing to everything it found elsewhere. Each run found something different: one found K4 (the widget-area race, never found before), another K5 (Durable Object SQL transactions; raised only as a suggestion), and another K14. Summed over its runs, Opus found at least once K1, K2, K4, K5, K6, K9, K11 and K14, plus a partial K3 and K10.
- **Sol is consistent but narrow**: 4 of 16 in every run, the same items each time (K1, K2, K6, K11). It never flagged 4225 or 4221 and approved them all nine times.
- **False claims**: both raised the same overstated needs-fixing point on clean 4172 (speculative reads before the backoff check), so both gave it a `comment`. Neither repeated the known false masking claim. Every other clean-PR verdict was right, with no other needs-fixing findings.
- **Human PRs**: Opus found the 4208 bug class in a different place (full-text search title detection, verified at the head) rather than media-usage discovery. Sol again found 4128's taxonomy bug, which Opus missed.

Single runs of either model are not reliable enough to compare variants on five PRs. Opus finds more over repeated runs, Sol is more predictable. Running two independent reviews would catch more on the bot PRs than one Opus review.

## Merge

`.flue/lib/review-merge.ts` merges independent reviews into one `ReviewResult`; it is not wired into the workflow. A merge model with no tools gets both structured reviews. It must keep every finding, collapse only true duplicates, keep disagreements, and write one summary. Trusted code then makes the decisions that do not depend on the model:

- **Verdict:** `request_changes` if either reviewer requested changes; `approve` only if both approved and no merged finding is needs-fixing; otherwise `comment`.
- **Anchors:** every merged anchor must match an input anchor. One in a reviewed file is moved to the nearest input anchor; one in any other file is dropped. Both are counted.
- **Coverage:** input findings that no merged finding covers are reported.
- **Fallback:** a deterministic union, deduplicated only by same path and overlapping lines, used when the merge call fails or its output is invalid.
- **One reviewer:** a single review is returned unchanged, with a note that the other reviewer was unavailable.

`eval/merge.ts` merged the 23 Opus and Sol issue+framing pairs offline (15 bot-PR pairs, 8 human-PR pairs) with Claude Haiku 5.5 and Claude Sonnet 5.5 (effort `low`) and GPT-5.6 Luna (reasoning `low`) through AI Gateway, and with the deterministic fallback. Key items were scored from the merged text against each pair's graded inputs, and every lost or suspect item was checked by hand.

Mechanical checks (52 input findings across the 23 pairs):

|                                       | Haiku              | Sonnet | Luna                                | Fallback |
| ------------------------------------- | ------------------ | ------ | ----------------------------------- | -------- |
| Findings out                          | 41                 | 45     | 40                                  | 44       |
| Distinct findings dropped             | 0                  | 0      | 1                                   | 0        |
| Key points lost                       | 0                  | 0      | 1 (4226 v1 K3, a summary-only note) | 0        |
| Invented anchors (repaired / dropped) | 0 / 0              | 0 / 0  | 0 / 0                               | –        |
| Invalid output (fallback used)        | 1 (malformed JSON) | 0      | 0                                   | –        |
| Mean latency                          | 5.4 s              | 6.5 s  | 5.1 s                               | –        |
| Mean cost per merge                   | $0.0009            | $0.014 | $0.0010                             | –        |

The other uncovered inputs (4 for Haiku, 4 for Luna) were true duplicates collapsed onto the other reviewer's anchor, keeping the content. Luna's one distinct drop was Opus's changeset-scope suggestion on 4224 v2.

Graded results:

|                                        | Opus alone | Sol alone | Merged (Haiku) | Merged (Sonnet) | Merged (Luna) | Fallback |
| -------------------------------------- | ---------- | --------- | -------------- | --------------- | ------------- | -------- |
| Bot key score, mean of 3 (16)          | 5.3        | 4.0       | 6.3            | 6.3             | 6.2           | 6.3      |
| Human key score (4)                    | 2.5        | 2         | 3.5            | 3.5             | 3.5           | 3.5      |
| Flagged-PR runs that missed everything | 4 of 17    | 7 of 17   | 1 of 17        | 1 of 17         | 1 of 17       | 1 of 17  |
| Verdicts right                         | 15 of 21   | 13 of 21  | 17 of 21       | 17 of 21        | 17 of 21      | 17 of 21 |
| False alarms on clean PRs              | 1          | 1         | 1              | 1               | 1             | 1        |

| Bot PR (points) | Opus | Sol | Haiku | Sonnet | Luna | Fallback |
| --------------- | ---- | --- | ----- | ------ | ---- | -------- |
| 4226 (3)        | 2.2  | 2.0 | 2.2   | 2.2    | 2.0  | 2.2      |
| 4225 (4)        | 0.7  | 0   | 0.7   | 0.7    | 0.7  | 0.7      |
| 4224 (3)        | 1.0  | 1.0 | 1.3   | 1.3    | 1.3  | 1.3      |
| 4221 (2)        | 1.0  | 0   | 1.0   | 1.0    | 1.0  | 1.0      |
| 4201 (4)        | 0.5  | 1.0 | 1.2   | 1.2    | 1.2  | 1.2      |

- **Merging works:** merging two reviews beats either alone. The key score rises from 5.3 to 6.3 of 16, runs that missed everything on a flagged PR fall from 4 to 1, and verdicts improve from 15 to 17 of 21. The one remaining all-miss is 4225 v1, where both reviewers approved with no findings.
- **The merge model barely matters for recall:** the deterministic union scores the same, because the gains come from combining the reviews, not from rewriting them. The model adds a single readable summary and collapses duplicates across anchors; the fallback keeps both summaries under reviewer headings.
- **Remaining errors:** both reviewers raised the same overstated 4172 point, so every merge keeps it. 4208 merges approve, because both reviewers approved and the FTS point was only a suggestion.
- **Choice of merge model:** Haiku is cheapest but returned malformed JSON once, which the fallback absorbed. Sonnet was the only model that never dropped anything, at about $0.014 a merge. Luna dropped one distinct suggestion and one summary-only point.
