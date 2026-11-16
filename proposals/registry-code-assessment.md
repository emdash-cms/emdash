---
title: Registry release code assessment
type: rfc
status: proposed
authors:
  - Matt Kane (@ascorbic)
champion: Matt Kane (@ascorbic)
sponsor: null
discussions: []
created: 2026-11-16
---

# Registry release code assessment

## Summary

The plugin registry labeler assesses a release's package code as well as its listing text and images. The labeler reads the signed package bundle from the registry blob cache, verifies it against the release record's checksum, and unpacks it in memory without running it. Deterministic checks report only archives that the installer would reject or that break the bundle layout. Everything else is found by language-model reviewers in a separate Worker, `apps/plugin-review`. Each reviewer reads the whole bundle through list, read and search tools and must cite the lines behind every finding.

The review prompt is public. During an embargo, a private addendum held in a Worker secret adds guidance about an undisclosed issue without putting it in this repository. A code finding holds the release for operator review. A code assessment that cannot finish marks the whole assessment as an error, so a reviewer failure never passes a release.

## Problem and user case

The labeler gives a release `listing-passed` after it checks the listing's text, links and images. The listing prompt in `apps/labeler/src/ai/prompts.ts` tells the model not to assess code. A release that passes can therefore still ship code that sends site content to an undeclared host, decodes and runs a hidden payload, or exposes private data on a public route. Operators find out only if someone reads the bundle.

A list of known-bad patterns does not solve this. Malicious code is easy to rewrite past a static rule, and broad access is normal: a webhook or federation plugin needs to reach any host. The useful question is whether the code does something the plugin's stated purpose does not explain, which needs a reader, not a pattern match.

## Example

A release lists itself as "Shows public post counts", declares `content.read`, and ships this `backend.js`:

```js title="backend.js"
export default {
	routes: {
		stats: {
			public: true,
			handler: async (ctx) => ctx.content.list("posts", { status: "draft" }),
		},
	},
};
```

A reviewer reads the listing text, the declared access and every bundle file, then submits:

```json
{
	"summary": "Counts posts, but its public stats route returns draft posts to anyone.",
	"findings": [
		{
			"category": "vulnerability",
			"severity": "high",
			"confidence": 0.8,
			"summary": "The public stats route lists draft posts, so an unauthenticated visitor can read unpublished content.",
			"evidence": [
				{
					"file": "backend.js",
					"line": 5,
					"quote": "ctx.content.list(\"posts\", { status: \"draft\" })"
				}
			]
		}
	]
}
```

The release receives `listing-review`. The operator sees a `vulnerability` finding with severity `high` and the evidence reference `release.package:backend.js#L5`. The assessment's `summary_json.codeIdentity` records each reviewer's model and prompt version.

## Goals

- Assess every release's package code when code assessment is configured.
- Find malicious behaviour and egregious vulnerabilities by reading the code against its stated purpose, not by matching a fixed list.
- Never evaluate, import or run bundle code.
- Keep guidance about undisclosed vulnerabilities out of the public repository.
- Attach severity, confidence and line-level evidence to every finding.
- Fail closed: a code assessment that cannot finish never passes a release.
- Bound review cost per publisher and in total.

## Non-goals

- A backward-looking review of releases that are already published. That runs separately.
- Blocking releases automatically. Blocking stays an operator action (`listing-blocked`).
- Code quality, style, performance or licensing review.
- Showing code findings in the public assessment output.
- Admin UI changes for severity.

## Detailed design

### Pipeline

Code assessment is a stage of the existing assessment Workflow. It runs after the image stage, only for release subjects, and only when `AssessmentWorkflowDependencies.codeAssessment` is configured. Each step is a durable `step.do`:

1. **Verify and project release package.** Re-verify the exact release record, then project only what the stage needs: the subject URI and CID, the version, the package artifact's `checksum` and blob CID, and `declaredAccess`. The projection excludes the publisher's package URL.
2. **Check release package.** Read, verify and unpack the bundle, and turn archive anomalies into `package-integrity` findings.
3. **Reserve package review budget.** See [Rate limits](#rate-limits).
4. **Review release package with `<model>`.** One step per configured model, run in parallel. Each step re-reads and re-verifies the bundle, so no bundle bytes are stored in Workflow state, then calls the review Worker. Each step retries twice with exponential backoff and times out after 20 minutes.

The stage unions the integrity findings and every reviewer's findings into `{ status: "complete", result }`. Reviews run even when the check finds anomalies, so the operator sees both. Any thrown error, including a reviewer that fails after its retries, is logged as `assessment_code_stage_failed` and becomes `{ status: "error", code: "code-assessment-unavailable" }`.

A release passes the code stage only when every reviewer completes and no reviewer or check reports a finding.

### Bundle intake

The labeler reads the bundle from the record-scoped registry blob cache (`REGISTRY_CUMULUS_ORIGIN` through the `REGISTRY_BLOB_CACHE` service binding), using the same guarded fetch, socket-pinned transport and redirect rules as display media. It never fetches the publisher's `artifacts.package.url`. A release whose package has no blob CID cannot be read, so its code assessment fails and the assessment is an error.

The labeler reads at most `MAX_BUNDLE_COMPRESSED_BYTES` and checks the bytes against the record:

- When the record has a blob CID, its multihash must match the `checksum`.
- The SHA-256 multihash of the bytes must match the `checksum`.

A mismatch fails the stage. A verified bundle is gunzipped with `DecompressionStream`, capped at `MAX_BUNDLE_DECOMPRESSED_BYTES`, and parsed as USTAR in memory. The size and entry limits come from `@emdash-cms/registry-verification/bundle`, so the labeler and the publishing tools use the same values.

### Deterministic checks

The tar parser records anomalies instead of throwing, and applies the installer's entry rules: a directory entry must end in `/` and have size 0, a file entry must not end in `/`, and a name field must contain nothing after its terminating NUL. Each anomaly code becomes one `package-integrity` finding with the summary `bundle.<code>: …` and evidence references `release.package:entry[<n>]`.

| Anomaly                                                                           | Severity |
| --------------------------------------------------------------------------------- | -------- |
| `path-traversal`                                                                  | critical |
| `symlink`, `hardlink`, `unsupported-entry-type`, `unsafe-path`, `duplicate-entry` | high     |
| size, count, gzip and archive-format limits                                       | high     |
| `unexpected-entry`, `missing-required-entry`, `invalid-text-encoding`             | medium   |

Duplicates are detected after Unicode NFC normalization and lowercasing. Expected entries are `manifest.json`, `backend.js`, `admin.js`, `README.md`, `icon.png` and `screenshots/*.{png,jpg,jpeg}`, with an optional leading `./`. `manifest.json` and `backend.js` are required. Text files (`.js`, `.mjs`, `.json`, `.md`) are decoded as strict UTF-8.

These are the only deterministic checks. Everything that depends on what the code does is left to the reviewers.

### Review Worker

`apps/plugin-review` is a Worker with no public routes. Its default `WorkerEntrypoint` exposes one RPC method, `review(request)`, reached through the labeler's `PLUGIN_REVIEW` service binding. A request names one model and carries the subject, the listing text, the declared access and the bundle files. Binary files are listed by path and size, without content.

The Worker calls the model through AI Gateway with Unified Billing, using `@earendil-works/pi-ai` with the Anthropic Messages and OpenAI Responses protocols. Models are `anthropic/<id>` or `openai/<id>` specifiers. There is no Workers AI fallback: missing gateway settings fail the review.

The model works through four tools over an in-memory copy of the bundle:

| Tool            | Behaviour                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_files`    | Paths, sizes and line counts.                                                                                                              |
| `read_file`     | A 16,000-character window with line numbers, and the offset of the next window. A `+` marks a line that started before the window.         |
| `search`        | Literal or regular-expression search, at most 50 matches with 120 characters of context. Regular expressions are capped at 200 characters. |
| `submit_review` | The summary and findings.                                                                                                                  |

The model cannot run code, and nothing in the bundle is evaluated. Every tool result that contains publisher-controlled text, including the listing text and declared access in the first message, is fenced between `<<<BUNDLE <token>>>` and `<<<END BUNDLE <token>>>` markers. The token is a random UUID per review, so bundle text cannot forge a closing marker.

Trusted code checks each `submit_review` call before accepting it:

- Every text file must have been read in full, across all windows.
- At most 16 findings, each with a known category and severity, a confidence from 0 to 1, a non-empty summary, and one to eight citations.
- Each citation names an existing file and line, and its quote, 3 to 300 characters after trimming, appears on that line.

A rejected submission goes back to the model as a tool error listing the problems. The review fails after three rejected submissions, after 60 turns, after the model answers three times without calling a tool, or when the provider reports an error.

The labeler treats the review Worker's response as untrusted too. `parseReviewResponse` checks that the response names the requested model, that categories, severities and confidence are valid, and that every citation names a line that exists in the bundle the labeler verified. It turns citations into evidence references of the form `release.package:<file>#L<line>`. A response that fails these checks fails the stage.

### Prompt

The prompt is in [`apps/plugin-review/src/prompt.ts`](../apps/plugin-review/src/prompt.ts). It describes the sandboxed plugin model and asks the reviewer to report only three categories:

- `malicious-code`: behaviour the stated purpose does not explain and that harms the site, its users or its visitors, or that hides itself.
- `vulnerability`: an egregious flaw, whatever the author's intent, that lets an unauthenticated outsider harm a site in the plugin's default configuration, with the whole path from the public entry point traced.
- `reviewer-manipulation`: text that tries to steer an automated or human reviewer.

It states that broad access, including unrestricted network access, is not a finding by itself; that minified code is not obfuscation by itself; and that finding nothing is a normal result. It sets out a work order (establish the purpose, read everything, map behaviour, compare, try to disprove each candidate, submit) and defines severity so that the reviewer picks the lower level when unsure.

`PROMPT_VERSION` is recorded with every review. Change it when a prompt change should be distinguishable in assessment records. The prompt text is not hashed.

The `PLUGIN_REVIEW_PROMPT_ADDENDUM` secret, when set, is appended under "Additional guidance". It is the only place guidance about an undisclosed vulnerability goes. Remove it, and move anything that should stay into the public prompt, once the issue is disclosed.

### Rate limits

Each release review reserves one unit from two daily budgets in D1 before any model runs: one for the publisher's DID and one shared by all publishers. The defaults are 20 reviews per publisher and 500 in total per UTC day, configurable with `LABELER_CODE_REVIEW_DAILY_LIMIT_PER_PUBLISHER` and `LABELER_CODE_REVIEW_DAILY_LIMIT`. A reservation is one conditional upsert per scope on `code_review_budget`; when the shared budget refuses, the publisher's unit is returned.

When a budget is exhausted, the Workflow sleeps until the next UTC midnight with `step.sleepUntil` and tries again, up to seven times. A release waits rather than skipping review. After the seventh wait the stage fails and the release gets `listing-error`.

One reservation covers every configured model, so the budgets count releases, not model calls.

### Policy and storage

`resolveAssessmentPolicy` accepts an optional `code` stage:

- A complete stage adds `coverage.code = "complete"`, its findings and `codeIdentity` (`{ reviewers: [{ model, promptVersion }] }`).
- Any code finding gives the outcome `review` with `policy-finding`, like listing findings.
- A failed stage sets `coverage.code = "unavailable"`, which counts as missing required coverage. The outcome is `error`, labelled `listing-error`, with the reason codes `required-coverage-unavailable` and `code:<error code>`.

Without a `code` stage, coverage and outcomes are unchanged.

Findings are stored in the existing `findings` table. Migration `0012_code_assessment.sql` adds a nullable `severity` column and the `code_review_budget` table. The operator API returns severity. `@emdash-cms/registry-moderation` adds `CODE_FINDING_CATEGORIES` (`malicious-code`, `vulnerability`, `reviewer-manipulation`, `package-integrity`), `FINDING_SEVERITIES` and `AssessmentFindingSchema`. `NormalizedModerationFindingSchema` still accepts listing categories only, so the listing model and the Clef adapter cannot emit code categories.

The public assessment output is unchanged. It maps code categories to `uncertain` with the canned summary, so finding text never appears publicly.

### Notifying the publisher

An administrator can email a release's code findings to the package's security contacts with the **Email publisher** action on the assessment. The action calls `POST /_admin/api/assessments/<run key>/notify-publisher` with the subject URI and CID and a reason, under the same transport, authentication and idempotency rules as the other operator actions. Reviewers cannot send.

Recipients are the `email` values in the current package profile's `security` contacts, read from that profile's latest assessment. Addresses are trimmed, deduplicated case-insensitively, rejected if they contain whitespace or address separators, and capped at five. The publisher profile's contacts are not used.

The labeler sends through the `PUBLISHER_EMAIL` `send_email` binding, which may send only from `plugin-notify@emdashcms.com`. Replies go to that address, and Email Routing forwards them to the shared inbox.

The email names the package and release, then lists each code finding's category, severity, summary and cited lines, for example `backend.js line 5`. Listing findings, confidence, the reviewer models and the operator's reason are not sent. The assessment detail returns the drafted subject and text, and the admin dialog shows them before the operator sends, so an operator can catch a summary that mentions something under embargo.

`publisher_notifications` (migration `0013_publisher_notifications.sql`) allows one sent email per assessment run. A rerun is a new run and can be sent again. The route claims the row before sending and records the message ID or the Email Service error code afterwards. A failed attempt, or one left in `sending` for 15 minutes, can be retried; a sent one returns `ALREADY_NOTIFIED`. Replaying the same idempotency key returns the original result without sending again.

| Error                 | Status | Cause                                                      |
| --------------------- | ------ | ---------------------------------------------------------- |
| `NO_CODE_FINDINGS`    | 409    | The assessment has no code findings.                       |
| `NO_SECURITY_CONTACT` | 409    | The package profile has no usable security email.          |
| `ALREADY_NOTIFIED`    | 409    | This assessment run was already emailed.                   |
| `EMAIL_SEND_FAILED`   | 502    | Email Service rejected the message; the attempt is logged. |

Sends are not written to `operator_actions`, whose `action` constraint does not allow them, so they do not appear in the admin activity view.

### Evaluation

`apps/plugin-review/eval/run.ts` runs the reviewer against a set of bundles with each model and reports whether each case produced its expected categories. The cases are not committed: most are malicious bundles, and publishing them would show attackers what the reviewer is tested against. The runner loads cases from `EVAL_CASES_DIR` and refuses a directory inside the repository. Clean cases, which pass only when the reviewer reports nothing, measure false positives.

## Compatibility and migration

All changes are additive:

- The code stage is off unless `LABELER_CODE_REVIEW_MODELS` is set.
- Existing run keys and fingerprints do not change.
- The `severity` column is nullable, and existing rows keep `NULL`. The budget table is new.
- The `@emdash-cms/registry-moderation` and `@emdash-cms/registry-verification` additions are new exports.

Rollback is unsetting `LABELER_CODE_REVIEW_MODELS`. Assessments that already ran keep their findings and labels.

## Security and privacy

- **Bundle code is untrusted.** Neither Worker evaluates or imports it. Tar parsing is in memory with fixed caps; paths never reach a filesystem.
- **Bundle bytes are verified.** Bytes come from the registry blob cache and must match the signed record's checksum before they are unpacked.
- **The publisher URL is never fetched.** The projection excludes it.
- **Prompt injection.** Bundle text reaches the model only inside per-review fences, and the prompt tells the model that fenced text cannot instruct it and that attempts to do so are a `reviewer-manipulation` finding. The model's only actions are reading the bundle and submitting a review. Trusted code, not the model, decides the outcome, and any finding holds the release, so a manipulated reviewer can at worst miss something another reviewer catches. Running more than one model from different providers reduces that risk.
- **Model output is untrusted.** Both Workers check citations against the bundle before a finding is accepted.
- **Embargoed guidance.** The public repository holds the prompt and runner but no evaluation cases and no addendum. The addendum is a Worker secret.
- **Publisher email.** Recipients come only from the verified package profile, and addresses with whitespace or separators are dropped, so a profile cannot add headers or extra recipients. The binding can send only from `plugin-notify@emdashcms.com`. Finding text is HTML-escaped in the HTML part.
- **Data sent to model providers.** Bundles, listing text and declared access are public in the registry already. They are sent to the configured providers through AI Gateway.
- **Provider safety refusals.** A model may refuse to analyse malicious code. A refusal ends without a submission, so the review fails and the release gets `listing-error` instead of passing.

## Performance

The stage runs inside the assessment Workflow, not on a visitor request, so no logged-out route changes. Each release assessment adds one blob-cache read for the check and one per reviewer, two D1 writes for the budget, and one review per configured model. A review is a multi-turn tool conversation; a bundle at the 128 KB file limit takes about eight `read_file` windows per file plus searches. The labeler bundle no longer includes a JavaScript parser.

## Failure handling

Any failure in the code stage gives `listing-error` with `coverage.code = "unavailable"`:

- an unreadable bundle or checksum mismatch;
- a missing `PLUGIN_REVIEW` binding or invalid model list;
- a reviewer that errors, refuses, or never submits a valid review after its step retries;
- a review response that cites a line outside the bundle; or
- a budget that stays exhausted for seven days.

The failure is logged as `assessment_code_stage_failed` with the subject and error message. An operator can re-run the assessment after fixing the cause. Archive anomalies are findings, not failures.

## Verification

Tests in `apps/labeler/test` cover:

- tar anomalies, including the installer's directory and name rules;
- the D1 budget, per publisher and in total, including returning a refused publisher unit;
- production configuration: off by default, a missing binding, invalid models and limits;
- policy resolution with complete, findings and failed code stages; and
- the full Workflow: a clean pass with two reviewers, a reviewer finding, archive anomalies alongside a review, waiting for budget, and fail-closed handling of an unreadable bundle, a checksum mismatch, a failing reviewer, an out-of-bundle citation and an exhausted budget.

Tests in `apps/plugin-review/test` use scripted models and harmless bundles to cover windowed reading and coverage tracking, search limits, submission checks, resubmission after a rejected citation, tool errors, refusals and provider errors.

## Rollout and implementation

1. Apply the labeler D1 migration:
   ```bash
   pnpm --filter @emdash-cms/labeler exec wrangler d1 migrations apply emdash-labeler --remote
   ```
2. Set the review Worker's gateway secrets and deploy it:
   ```bash
   pnpm --filter @emdash-cms/plugin-review exec wrangler secret put AI_GATEWAY_ACCOUNT_ID
   ```
   ```bash
   pnpm --filter @emdash-cms/plugin-review exec wrangler secret put AI_GATEWAY_NAME
   ```
   ```bash
   pnpm --filter @emdash-cms/plugin-review exec wrangler secret put AI_GATEWAY_TOKEN
   ```
   ```bash
   pnpm --filter @emdash-cms/plugin-review run deploy
   ```
3. Run the private evaluation set against the deployed prompt and the chosen models.
4. Add a `PLUGIN_REVIEW` service binding to `emdash-plugin-review` in the labeler's `wrangler.jsonc`, and set `LABELER_CODE_REVIEW_MODELS`, for example `anthropic/claude-opus-5-5,openai/gpt-6.1-sol`. Optionally set the daily limits.
5. Onboard `emdashcms.com` to Email Sending, and route `plugin-notify@emdashcms.com` to the shared inbox with Email Routing. Until then, **Email publisher** fails with `EMAIL_SEND_FAILED`.
6. Deploy the labeler. New release assessments include the code stage.

During an embargo, set `PLUGIN_REVIEW_PROMPT_ADDENDUM` on the review Worker. No redeploy of the labeler is needed.

## Alternatives

- **Static detection rules.** An earlier draft matched JavaScript syntax and declared access against a private ruleset. Rules catch only what someone already wrote a rule for, are easy to rewrite past, and flagged legitimate broad access such as wildcard hosts. They also had to be private, which made the engine hard to review.
- **A code tool for the reviewer.** `infra/flue-review` gives its model a JavaScript tool in a Worker Loader isolate. Fixed read and search tools are enough to review a bundle of a few files, and they let trusted code track exactly what the model has read.
- **Reviewing in the labeler.** A separate Worker keeps the gateway secrets, the prompt addendum and the model SDK out of the labeler, and lets the review run longer than a labeler step.
- **A merge model.** `infra/flue-review` merges its reviewers' output with a third model. Here, any finding already holds the release for an operator, so a union is enough.
- **Blocking on critical findings.** Blocking stays an operator decision, so a false positive cannot remove a listing.

## Drawbacks

- Model reviews cost money and time for every release, and their judgement varies between runs.
- The labeler now depends on the blob cache, the review Worker and the model providers for every release. An outage in any of them gives `listing-error` until a re-run.
- A provider's safety filters can refuse some malicious bundles, which surface as errors rather than findings.

## Open questions

- **URL-only packages.** Releases whose package has no blob CID fail the code stage. Should they be a finding instead?
- **Prompt changes and existing assessments.** The prompt version is not in the run key. Should a new version trigger re-assessment of current releases?
- **Public lexicon.** The public assessment has no code coverage field or code categories, so code findings appear as `uncertain`. Should the lexicon gain them?
- **Admin UI.** The operator API returns severity, but the admin does not display it yet.
- **Notification activity.** Publisher emails are logged in their own table, not in the activity view. Should `operator_actions` gain the action?
- **Manifest consistency.** Neither Worker checks that the bundle's `manifest.json` declares the same access as the signed record.
- **`neverModel` fixture.** `PROHIBITED_ASSESSMENT_INPUTS_FIXTURE` lists `release.artifacts.package` as never sent to the listing model. The code review sends package files to separate models. The fixture should say which stage it governs.
