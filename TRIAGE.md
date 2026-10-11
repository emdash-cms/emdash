# Project Team triage guide

This guide is for Project Team members who help keep issues, Discussions, and pull requests understandable, actionable, and moving.

Project Team membership is broader than GitHub permissions. [GOVERNANCE.md](GOVERNANCE.md) defines the role, membership, and decision-making authority.

## You Are a Volunteer

- **There is no quota, schedule, or minimum commitment.** Triage when you have the time and energy, and don't when you don't.
- **Pick the work you enjoy.** If you like reproducing bugs, do that. If you prefer answering questions or welcoming first-time contributors, do that instead. Nobody covers everything.
- **You can step back at any time**, temporarily or permanently, no explanation needed.
- **Mistakes are fine.** Labels can be changed, issues can be reopened, comments can be clarified. Nothing in triage is irreversible.

If the work stops being enjoyable or a thread is stressing you out, hand it off and walk away. Sustainable help beats heroic help.

## Public and team coordination

Use public GitHub artifacts and the public `#contributing` Discord channel for substantive project discussion. GitHub holds the durable record of project decisions.

Use `#project-team` for trusted operational coordination:

- asking for help handling a difficult public thread;
- handing off work you cannot finish;
- finding an owner or reviewer; and
- flagging public work that needs attention.

Do not make product, architecture, roadmap, proposal, review, or governance decisions in `#project-team`. Move substantive reasoning to the relevant public GitHub artifact. [GOVERNANCE.md](GOVERNANCE.md#public-and-private-channels) defines the full public and private channel boundary.

## What Triage access lets you do

The GitHub triage role lets you:

- Apply and remove labels
- Close, reopen, and assign issues and PRs
- Mark issues as duplicates
- Add issues to milestones
- Request reviews on PRs

It does not let you merge PRs, push to branches, or change repository settings — those stay with maintainers.

You can also review pull requests. A Project Team review is useful evidence for the Maintainer who decides whether to approve, but it does not satisfy the required human Maintainer approval.

## Working with EmDashBot

@emdashbot is the project's automated implementation-pull-request reviewer:

- **It reviews implementation PRs automatically** when the PR is opened, reopened, or marked ready for review. New commits do not trigger another review.
- **Apply the `bot:review` label to summon a re-review**, for example after an author pushes significant changes. It sometimes fails to review the first time (e.g. if there's an error while it is running), in which case it is useful to ask for a re-review.
- **It skips drafts, design PRs, and unsolicited PRs opened by other bots.** A draft implementation PR gets its review when it is marked ready. `bot:review` never overrides the design-PR exclusion.
- Most PR labels — review state, size, area, CLA, `needs-rebase`, `stale` — are applied and removed automatically. See [PR Labels](#pr-labels) for what they mean.

EmDashBot compares a feature implementation with its linked accepted proposal. It reports omissions, divergences, unplanned scope, and missing tests alongside its normal correctness review.

Automated reviews are evidence, not approval. EmDashBot can have repository permissions and submit an approving GitHub review, but it is not a Maintainer and never satisfies the human approval requirement.

EmDashBot also works on issues (see [Issue work and `bot:*` labels](#issue-work-and-bot-labels)). It performs a bounded first pass on new issues, applies area labels and one kind label (`bot:bug`, `bot:enhancement`, or `bot:task`), and asks a focused question when the report lacks information. Issues opened by organization members and repository collaborators skip that pass until a maintainer runs `@emdashbot triage`. It may prepare a fix automatically for an obvious low-risk change, but deeper or sensitive work waits for maintainer approval. Every PR it opens still needs human Maintainer approval to merge.

You can help by:

- Confirming whether a bug is reproducible.
- Asking for missing reproduction details.
- Adding priority labels when the impact is clear.
- Redirecting the reporter if the report is a feature request (to Discussions) or support question (to the docs or the public Discord channels if you can't answer it).

And even on PRs, where the bot reviews every change, there is a lot of work it consistently can't do:

- **Running a real site.** The bot checks out the branch, but it doesn't build, run, or deploy it, or look at any real site. Clicking through the admin UI as an editor would, or trying a change against the workflows real users hit, catches things no code review will.
- **Judging whether the change should happen at all.** The bot reviews the diff in front of it and does try to judge if the fix is taking the right approach as well as being correct. However it won't notice that a feature contradicts a roadmap decision, that a fix papers over the real bug, or that the same problem was already solved elsewhere.
- **Understanding what the author actually meant.** Humans notice when the description and the code disagree, or when the interesting question is one the PR doesn't ask.
- **Empathy.** A first-time contributor who gets a kind, specific comment from a human is far more likely to stick around than one who only ever hears from a bot.

### Issue work and `bot:*` labels

New issues enter automatic triage, except issues opened by organization members and repository collaborators, Project Team members included. Those authors have usually looked into the issue already, so the bot waits for a command there. On such an issue, or on an older one, `@emdashbot triage` runs the same pass. The normal maintainer commands are:

- `@emdashbot triage` — classify the issue, check the relevant source area, apply useful labels, and decide whether to ask for information, await approval, or start low-risk work.
- `@emdashbot investigate` — reproduce and diagnose the report with evidence, without preparing a candidate.
- `@emdashbot work` — take the issue through reproduction where appropriate, implementation, verification, and a PR.
- `@emdashbot accept` / `@emdashbot needs changes <feedback>` — confirm the fix works or start another revision. The reporter can also reply naturally after trying the preview.
- `@emdashbot retry` — retry the last failed or timed-out run, using its saved workspace when available.
- `@emdashbot decline` — record that the issue won't be actioned (`bot:declined`); the issue itself stays open. From `bot:in-review` it also closes the bot's PR. Under `bot:needs-attention`, the PR stays open.
- `@emdashbot take over` / `@emdashbot hand back` — take the issue away from the bot so it stops acting on it (`bot:human-owned`), or return it to `bot:triage`.
- `@emdashbot reopen` — bring a `bot:done` or `bot:declined` issue back to `bot:triage`.
- `@emdashbot reset` — clear conflicting `bot:*` state labels and put the issue back to `bot:triage`.
- `@emdashbot status` / `@emdashbot help` — show the current state and available commands without changing anything.

Older `fix`, `implement`, and `repro` commands remain aliases for `work`. A maintainer does not need to choose between separate bug-fix and implementation modes.

`decline`, `take over`, and `reset` only run as the exact command, with nothing else after the mention. The other commands can also be written as a sentence after `@emdashbot`; the bot matches it to one of the commands the issue's current state offers.

Every verdict carries the commands and evidence behind it. "Could not reproduce," with a transcript, is a complete investigation outcome. Automatic triage never closes an issue or implements features and sensitive-area changes without approval.

**The preview loop.** When work produces a fix, the bot pushes `bot/fix-<n>`, waits for the `pkg.pr.new` preview, opens a PR, and asks the reporter to try the preview. If the preview fails to build, it opens the PR anyway and says so. The bot does not wait for the reporter before opening the PR, but a reporter who confirms the fix works gets the `triage/verified` label on the issue. Code review happens on the PR, where the bot watches checks, conflicts, and submitted maintainer reviews and continues repairing its branch until it is green or needs human attention.

Like the PR labels, the bot's lifecycle labels are managed by the bot:

- `bot:triage` — the issue is waiting for a decision on what the bot should do.
- `bot:triaging` — the bounded issue-classification pass is running.
- `bot:awaiting-approval` — triage found useful work that needs a maintainer decision.
- `bot:working` / `bot:investigating` — implementation or investigation is running.
- `bot:reproduced` / `bot:diagnosed` — the investigation found the cause, with or without a reproduction. The bot changes no code until a maintainer runs `work` or the reporter sends `@emdashbot needs changes <feedback>`.
- `bot:not-reproduced` — the bot could not reproduce the report; its comment has the transcript. The bot doesn't react to a reply here: if the reporter adds steps, a maintainer has to run `investigate` again.
- `bot:needs-info` — the reporter can unblock the next pass by replying with the requested details; no bot mention is required.
- `bot:preview-building` — a fix exists and its preview is being built.
- `bot:in-review` — a PR is attached; implementation discussion and automatic repair happen there. A reporter reply on the issue that asks for a change goes to the bot as feedback for that PR.
- `bot:needs-attention` — the fix or PR is retained, but the bot cannot continue safely without a maintainer.
- `bot:blocked` — the bot stopped and needs a human decision, for example because the reported behavior is intended or reproducing it needs conditions the bot can't set up. Its comment usually gives the reason.
- `bot:human-owned` — a maintainer took the issue over with `take over`; the bot starts no work on it until `hand back`.
- `bot:done` / `bot:declined` — the issue is finished: resolved (for example, the bot's PR merged) or won't be actioned. `reopen` brings it back.

[BOT_STATE_MACHINE.md](infra/emdash-bot/BOT_STATE_MACHINE.md) lists every state, the commands each one accepts, and the transitions between them. It is generated from the bot's source.

Read the bot's current comment before starting a manual reproduction. Its **View live dashboard** link shows the run's work plan and trace. `bot:in-review` means the implementation discussion has moved to the linked PR.

The bot's own PRs carry the `bot` label and no `review/*` state, and the review bot doesn't review them. A maintainer's review that requests changes or leaves comments starts the next revision, and so does a maintainer's `@emdashbot` comment with plain feedback on the PR.

(You may still see older `triage/*` labels other than `triage/verified` on issues filed before the switch to `bot:*`; treat them as historical.)

## AI-assisted contributions

AI-assisted contributions are welcome when they follow the [AI usage policy](AI_POLICY.md). A human understands and tests the change, explicitly authorises each issue or pull request, and remains responsible for the result.

Your job as a triager is not to detect AI — it's to check for that human understanding:

- If it's unclear whether anyone has actually run the change, ask. "What did you test, and how?" is a fair question on any PR, and a specific answer is a good sign.
- An author who can't answer questions about their own PR, or who responds only with pasted agent output, hasn't met the bar yet. Ask them to test and confirm in their own words; if that goes nowhere, leave it with the author and move on — the review state labels will track it from there.
- The same applies to issues: a human reproduces the bug before opening the report, and a contributor's agent does not post later issue comments or replies.

**Translation PRs are a special case.** We ask that only native or fluent speakers of the target language open translation PRs — AI-assisted translation is fine, but a fluent speaker must review the results and check them in a real demo site, where context, layout, and tone problems show up that a diff never will. If it's unclear whether the author is a native speaker or has looked at the translations running, ask before the PR gets a review. If _you_ are a fluent speaker of the target language, your review is particularly valuable — you can catch problems the bot and non-speakers can't.

## Tone

Assume good intent. Nobody has been using EmDash for very long, and many reporters are not coming from a technical background. Many PRs are by users who have never opened a PR before. A short, specific question is better than a long checklist.

Good triage comments are clear and kind:

```markdown
Thanks for the report. Could you add the EmDash version, the adapter you are using (`node` or `cloudflare`), and the smallest schema/content example that reproduces this?
```

Avoid comments that sound like blame:

```markdown
This is not reproducible. Please provide a real reproduction.
```

Prefer:

```markdown
I cannot reproduce this from the current description. Could you share the exact steps from a fresh project, or a small repo that shows the issue?
```

## Good Boundaries

Triage is about moving the conversation forward, not owning every outcome. It's fine to stop once you have made an issue clearer, confirmed a reproduction, found the right label, or identified the next maintainer decision.

- If a bug needs deeper debugging than you have time for, leave a note with what you checked and what is still unknown.
- If a PR needs product direction, architectural approval, or a breaking-change decision, label it and ask a maintainer to weigh in.
- If a report is confusing, ask one focused question rather than trying to solve every possibility at once.
- If a conversation gets tense, do not keep pushing. Step back and ask a maintainer to take over.
- If you are unsure whether to close, block, or redirect something, leave it open and explain what decision is needed.

The boundary runs the other way too: triage access doesn't move you away from writing code. If you reproduce a bug and can see the fix, opening the PR yourself is the best possible outcome — triaging your way into a contribution is the system working, not a conflict.

## Issue Triage

Not sure where to begin? A good first session: pick a `bug` issue with no `priority/*` label, try to reproduce it, and leave a comment with what you found. Confirmed, not confirmed, or "I got this far and then hit X" — all three move the issue forward.

Start by identifying what kind of issue it is.

| If it is...            | Do this                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| A bug report           | Ask for missing reproduction details, try to reproduce if practical, and add priority if the impact is clear. |
| A feature request      | Convert it to an Ideas Discussion, or point the author there.                                                 |
| A docs problem         | Add `documentation`, or comment with the specific page/section that needs work.                               |
| A support question     | Answer if you know, or point to docs, Discussions or Discord then close.                                      |
| A duplicate            | Link the earlier issue and close as a duplicate if you are confident.                                         |
| Not enough information | Add `Awaiting author response` and ask one or two specific questions.                                         |

The bug report template applies the `bug` label automatically, so you only need to add it yourself when a bug arrives through some other route.

Useful details to ask for on bug reports:

- EmDash version.
- Astro version.
- Runtime or adapter: Node, Cloudflare Workers, D1, SQLite, Postgres.
- Browser and OS for admin UI bugs.
- Relevant collection schema, field config, or plugin config.
- Exact steps to reproduce from a fresh project when possible.
- Expected behavior and actual behavior.
- Error logs or network response details.
- A screenshot for every report that refers to the interface.

Do not ask for everything by default. Ask for the smallest missing piece that would unblock the next person.

### Priority Labels

For issues, priority is often the best thing a human triager can add — it's a judgment call the bots can't make. These labels are new and most existing issues don't have one yet, so don't be shy about being the first to set it.

- `priority/urgent` for data loss, security, broken install/setup, major regressions, or anything that needs maintainer attention soon.
- `priority/high` for important user-facing bugs or work that affects common workflows.
- `priority/normal` for valid issues with no immediate urgency.
- `priority/low` for nice-to-have fixes, polish, edge cases, or cleanup.

Use priority labels when you have enough context to make a reasonable call. If you are unsure, leave priority unset and explain what information would help judge impact.

For bugs, a confirmed reproduction is the most useful evidence for priority. If you reproduce something, leave the exact environment and steps you used. A report that refers to the interface must include a screenshot showing the reported state. If it is missing, ask the author to add one. A short screen recording can supplement the screenshot when the bug depends on an interaction. You can drag or paste media into a GitHub comment, or attach a local file with `gh issue comment --attach './screenshot.png#Description of the reported state'` when using GitHub CLI 2.99.0 or later.

## PR Triage

First, decide whether the PR is something the project accepts. The full policy is in [CONTRIBUTING.md § Contribution Policy](CONTRIBUTING.md#contribution-policy); in short:

Accepted directly:

- Bug fixes with a reproducing test.
- Documentation and tests.
- Translation PRs from native or fluent speakers.
- Scoped chores.
- Behavior-preserving refactors and performance changes.

Needs an accepted design:

- Features.
- Behavior-changing refactors or performance changes.
- Public API, stored-data, security, compatibility, or architecture changes.

Normally closed without merging:

- Features with no merged design PR.
- New plugins. These should be published independently.
- Drive-by PRs that do not meet the eligibility rules in [AI_POLICY.md](AI_POLICY.md#pull-request-eligibility).

Every feature uses a merged design PR. A bounded feature uses a feature plan. A broader or harder-to-reverse change starts with an Ideas Discussion and then uses an RFC. [proposals/README.md](proposals/README.md) defines the boundary and approval rules.

Two things to calibrate on:

- **A small feature still needs a design.** Its feature plan can be short and has no fixed review period.
- **An Ideas Discussion does not accept a design.** It establishes the problem and demand before an RFC. Merging the later design PR accepts the implementation plan.

If a feature implementation has no merged design PR, leave a comment like:

```markdown
Thanks for the PR. Feature implementation starts after a feature plan or RFC has been accepted in a merged design PR. Please move the proposed behavior into a design PR using the process in `proposals/README.md`. You can keep prototype code in a fork while the design is reviewed.
```

### What To Look For Before Review

The bot does code-level review and is good at it, but it's not perfect. The most useful human checks are the ones the bot gets wrong or can't judge:

- Is the PR template filled out?
- Does the PR explain _why_ the change is needed, and does that reason hold up?
- For bug fixes, is there a test that would fail without the fix?
- For user-facing package behavior changes, is there a changeset, and is it well written? (See [Checking Changesets](#checking-changesets).)
- For admin UI changes, are user-facing strings localized and does the layout use RTL-safe classes?
- For UI changes, does the PR include screenshots of the rendered result?
- For a feature, does the PR link a merged design PR, and does the implementation conform to the accepted proposal?
- Are unrelated files changed, such as generated translation catalogs in a non-translation PR?
- Is the AI disclosure filled in, and has a human author understood and tested the change? (See [AI-Assisted Contributions](#ai-assisted-contributions).)
- For translation PRs, is the author a native or fluent speaker who has checked the translations in a real demo site?
- ...and most importantly: **does it actually work**? Checking out a branch and clicking through the admin UI catches things no bot review will.

You don't need to check all of these: any one of these checks on a PR is a useful contribution, and nobody runs the whole list every time.

If something is missing, ask for it directly and keep the request narrow. The `review/*` state labels update automatically, so there's nothing to set when a PR looks ready — but if the author has pushed significant changes since the bot's last pass, add `bot:review` to summon a re-review.

### Checking Changesets

A changeset is public documentation that lands verbatim in a package CHANGELOG. Review it with the canonical [changeset writing and review standard](.changeset/README.md), not only for presence, package names, and bump type.

Request a rewrite when technically accurate prose is still vague, implementation-centered, disproportionate to the impact, or missing required migration guidance. The entry must help someone decide whether the release matters to them and what action to take. Also check that useful feature explanations and examples appear in the canonical docs, not only in the changeset or PR description.

### PR Labels

Almost every label you'll see on a PR is applied and removed automatically. You read them to scan the queue; you don't manage them:

- `review/*` — four mutually exclusive review states, set by the same automation as the `Human Maintainer approval` check, so they always agree with it. Only reviews from Maintainers listed in [GOVERNANCE.md](GOVERNANCE.md#maintainers) count:
  - `review/approved` — the approval requirement is met: enough Maintainer approvals on the current revision (two for governance and privileged paths) and no outstanding change requests.
  - `review/needs-rereview` — commits have landed since the last Maintainer review, or since a Maintainer requested changes. Merging `main` into the branch doesn't count; a rebase does.
  - `review/awaiting-author` — a Maintainer requested changes or commented on the current revision.
  - `review/needs-review` — no Maintainer has reviewed yet, or the PR needs another approval.
- `type/design` — a feature plan, RFC, or proposal amendment. AI reviewers skip these PRs.
- `needs-approval` — CI hasn't run because the workflows are waiting for maintainer approval, which is normal for first-time contributors. Despite the name, it has nothing to do with Discussion approval.
- `needs-rebase` — the branch has merge conflicts with `main`.
- `stale` — the PR is waiting on its author (changes requested, merge conflicts, or still a draft) and has had no human activity for two weeks. Implementation PRs are closed a week after the warning unless someone responds; design PRs are warned but never closed for inactivity. A human comment or update keeps a promising PR alive. PRs waiting on a review never go stale.
- `size/*`, `area/*`, `bot`, and the CLA labels are applied when the PR is opened or updated. A PR whose CLA is still unsigned a day after it opens gets a reminder, and is closed at seven days.

The labels you apply by hand on a PR:

- `bot:review` to summon a bot re-review.
- `ci:run` to start CI on the PR's latest commit. It approves workflows waiting for approval (`needs-approval`) and re-runs failed jobs once CI has finished, for example after a flaky test. Approving runs the contributor's code on our runners, so read the diff first and don't approve anything that touches workflows, build scripts, or dependencies in ways you can't account for. The label removes itself, so add it again for another attempt, and again after the contributor pushes new commits.
- `blocked` when progress depends on another issue, PR, or maintainer decision.

## Discussions

Ideas Discussions are the request inbox and the first step for full RFCs. They can describe an early request, a roadmap discovery problem, an offer to champion a design, or an offer to implement it. A requester does not need to design the solution.

- **Answer Q&A questions when you can**, and mark the accepted answer so the next person searching finds it. A marked answer turns a one-off reply into documentation.
- **Weigh in on Ideas.** Add concrete use cases, constraints, related work, and evidence of demand. Discussion feedback shapes the problem before an RFC is written.
- **Convert misfiled issues.** A feature request opened as an issue can be converted to an Ideas Discussion directly (the "Convert to discussion" option in the issue sidebar) — friendlier than asking the author to repost.
- **Connect the dots.** Link related Discussions, issues, and prior proposals. Many ideas have been discussed before, and a link to the earlier thread saves everyone from re-litigating it.
- **Surface requests that need a decision.** If an Idea has clear use cases and community support but no Maintainer response, flag its public link in `#project-team`.

Triage does not accept a design or commit the project to implementation. A merged design PR accepts a feature plan or RFC. Roadmap placement is a separate decision for project-led work.

### Sorting Ideas

Most Ideas need sorting rather than detailed discussion. Sort an Idea with one of these labels:

- `Design PR welcome` — the project would consider the feature, and anyone can propose it in a feature plan or RFC.
- `Better as a plugin` — the feature fits an independently published plugin better than EmDash itself.
- `Out of scope` — the feature does not fit the project. Explain why, then close the Discussion.

Sort an Idea yourself when the answer is clear from documented policy or earlier decisions. Otherwise flag it in `#project-team` or bring it to a regular project call, where Ideas can be evaluated together. There is no deadline for a first response.

A `Design PR welcome` Idea stays open until its design is implemented. Automation links the design PR from the Idea when the PR opens, comments when the design PR merges, and closes the Idea when the implementation that completes the proposal merges (see [Linked Ideas Discussions](proposals/README.md#linked-ideas-discussions)).

## Area Labels

On PRs, area labels are applied automatically from the changed file paths. On issues, they are a human call — useful when they are obvious, but not the main goal of triage. Do not spend much time guessing; a clear comment and a good priority label are usually worth more than a perfect area label.

- `area/admin` for the React admin UI.
- `area/auth` for passkeys, sessions, users, roles, and login.
- `area/cloudflare` for Workers, D1, R2, bindings, and deployment on Cloudflare.
- `area/core` for the main `emdash` package, schema, content APIs, runtime, database, and rendering helpers.
- `area/plugins` for plugin APIs and first-party plugins.
- `area/templates` for starter templates.
- `area/docs` for documentation.
- `area/cli` for command-line tooling.
- `area/ci` for GitHub Actions, release automation, tests, and repository tooling.

Use one or two. If an issue spans many areas, label the primary area and explain the overlap in a comment.

Two other labels worth applying when they fit: `good first issue` for well-scoped bugs with a clear fix location, and `help wanted` for valid issues maintainers are unlikely to get to soon.

Leave the `roadmap/*` labels alone — they are curated by maintainers as part of roadmap planning.

## Closing Issues

Close only when the reason is clear:

- Duplicate of an existing issue.
- The report is not actionable after a reasonable request for information.
- The behavior is documented or confirmed as intended.
- The issue was fixed by a merged PR.

When closing, leave a short explanation. If it closed as a duplicate, use the "Close as duplicate" feature to link the original issue. This is available in the menu next to the "Close issue" button. If you are unsure, do not close. Add a label and ask a maintainer.

## Escalate to a Maintainer

To escalate, post the public link in `#project-team` or mention a Maintainer in the public thread, and say what decision is needed. Ask a Maintainer to step in when:

- A report involves data loss, security, auth bypass, or production outage risk.
- A contributor is proposing a breaking change.
- A PR changes database migrations or content table behavior in a way you are unsure about.
- A discussion turns argumentative.
- A contributor needs a product or roadmap decision.
- You are not sure whether closing would be fair.

Escalating is a normal outcome of triage, so don't worry if you need to.

**Security reports should not be debugged in public.** If an issue appears to describe a vulnerability, don't ask for exploit details in the thread. Ask the reporter to resubmit through [private vulnerability reporting](https://github.com/emdash-cms/emdash/security/advisories/new) (the "Report a vulnerability" button on the Security tab), close the issue, and flag it in `#maintainers`.

## Useful Links

- [EmDash Discord](https://discord.gg/YY9vBaQRYt) — use public `#contributing` by default
- [Governance](GOVERNANCE.md)
- [Feature plans and RFCs](proposals/README.md)
- [Contributing guide](CONTRIBUTING.md)
- [Architecture and code patterns](AGENTS.md)
- [Documentation](https://docs.emdashcms.com)
- [Discussions](https://github.com/emdash-cms/emdash/discussions)
- [Issues](https://github.com/emdash-cms/emdash/issues)
- [Pull requests](https://github.com/emdash-cms/emdash/pulls)
