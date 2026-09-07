# Community Triage Guide

Thank you for helping with EmDash. This guide is for community members who have been given triage access to the repository.

The triage team is a small group of trusted community members who help keep issues and PRs understandable, actionable, and moving. This is some of the most valuable work in the project.

## You Are a Volunteer

- **There is no quota, schedule, or minimum commitment.** Triage when you have the time and energy, and don't when you don't.
- **Pick the work you enjoy.** If you like reproducing bugs, do that. If you prefer answering questions or welcoming first-time contributors, do that instead. Nobody covers everything.
- **You can step back at any time**, temporarily or permanently, no explanation needed.
- **Mistakes are fine.** Labels can be changed, issues can be reopened, comments can be clarified. Nothing in triage is irreversible.

If the work stops being enjoyable or a thread is stressing you out, hand it off and walk away. Sustainable help beats heroic help.

## Discord

Triagers get the **Triage Team** role on the EmDash Discord, and the private `#triage` channel is home base. Use it for anything that doesn't belong on a public thread:

- "Am I handling this right?" — no question is too small, especially early on.
- Handing off an issue or PR you've started on but can't finish.
- Flagging something to maintainers informally before (or instead of) a formal escalation.
- Talking through a tricky report with the rest of the team.

When in doubt, ask in the channel. A thirty-second question there beats an hour of second-guessing on a public thread.

## What Triage Access Lets You Do

The GitHub triage role lets you:

- Apply and remove labels
- Close, reopen, and assign issues and PRs
- Mark issues as duplicates
- Add issues to milestones
- Request reviews on PRs

It does not let you merge PRs, push to branches, or change repository settings — those stay with maintainers.

You can also review and approve PRs. A triager's approval doesn't change the PR's status to "approved", but it is still useful: it tells maintainers "a human has looked at this and it holds up," which makes the final review much faster. A PR still needs maintainer approval before it can be merged, but don't let that stop you from giving one.

## Working With the Bots

EmDash has a lot of automation. Probably the most important piece is @emdashbot, the AI code review bot:

- **It reviews every PR automatically** and is generally solid at catching mechanical problems: bugs in the diff, missing tests, pattern violations, SQL injection risks.
- **Apply the `bot:review` label to summon a re-review**, for example after an author pushes significant changes. It sometimes fails to review the first time (e.g. if there's an error while it is running), in which case it is useful to ask for a re-review.
- Most PR labels — review state, size, area, CLA, `needs-rebase`, `stale` — are applied and removed automatically by workflows. See [PR Labels](#pr-labels) for what they mean.

Issue triage is a different story. There is a separate issue-investigation bot (see [The Investigation Bot and `bot:*` Labels](#the-investigation-bot-and-bot-labels)), but its expensive work only runs when a **maintainer** explicitly asks for it, and a human always owns the outcome. In practice, most issues are still triaged and reproduced by humans, so your work here is particularly valuable.

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

## AI-Assisted Contributions

The majority of PRs are now written largely or entirely by agents, and some issues are too. That's fine for PRs: AI-assisted contributions are welcome and held to the same bar as any other (see [CONTRIBUTING.md § AI-generated PRs](CONTRIBUTING.md#ai-generated-prs)). What the project asks is that **a human understands the change and has tested it**. The submitter is responsible for correctness, not the tool. This is also why we discourage using agents to submit _issues_ — the reporter should have actually seen the bug, not just had an agent predict one. It's fine to have an agent help write a report, but the reporter should have actually run the code and seen the bug themselves, and should generally submit the issue in their own words.

Your job as a triager is not to detect AI — it's to check for that human understanding:

- If it's unclear whether anyone has actually run the change, ask. "What did you test, and how?" is a fair question on any PR, and a specific answer is a good sign.
- An author who can't answer questions about their own PR, or who responds only with pasted agent output, hasn't met the bar yet. Ask them to test and confirm in their own words; if that goes nowhere, leave it with the author and move on — the review state labels will track it from there.
- The same applies to issues: the reporter should have actually seen the bug, not just had an agent predict one.

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

### The Investigation Bot and `bot:*` Labels

A maintainer can hand an issue to the investigation bot with an `@emdashbot` comment. The bot classifies and routes issues when they mention `@emdashbot`, and the expensive work — reproducing, diagnosing, building a fix — only runs on an explicit **maintainer** directive, so you will not trigger it yourself:

- `@emdashbot investigate` — reproduce the bug and diagnose it, with evidence. It does not attempt a fix; it posts a verdict.
- `@emdashbot fix` — on an issue the bot already reproduced, build a candidate fix on a `bot/fix-<n>` branch and publish a preview for the reporter to try (see below). No pull request opens until the reporter confirms.
- `@emdashbot status` / `@emdashbot help` — anyone can ask; these just print the current state and the available commands.

Every verdict carries its evidence — the commands the bot ran and what it found. "Could not reproduce," with a transcript, is a first-class outcome, not a failure. The bot only proposes; a maintainer disposes.

**The reporter preview-confirm loop.** When a maintainer runs `@emdashbot fix`, the bot pushes a candidate branch, waits for a `pkg.pr.new` preview to publish, and then asks the _reporter_ to install that preview and confirm it fixes their case against their own site — the only place a site-specific bug reliably reproduces. If the reporter confirms, a draft PR opens. If they say it is still broken, or stay silent for two weeks, the bot reaps the candidate branch and falls back to the reproduced verdict for a maintainer to pick up. If you are the reporter, trying the preview is the single most useful thing you can do.

Like the PR labels, the bot's state labels are managed by the bot — you read them, you don't set them:

- `bot:investigating` — a reproduce-and-diagnose run is in flight.
- `bot:reproduced` — reproduced, with a diagnosis attached; resting until a maintainer triggers a fix or disposes of it.
- `bot:diagnosed` — root cause identified but not confirmed by a reproduction (environment limits). Actionable like `bot:reproduced`; the fix loop verifies with a failing test before changing anything.
- `bot:not-reproduced` — could not reproduce, transcript attached. Add steps and a maintainer can re-investigate.
- `bot:needs-info` — the investigation needs information only the reporter has.
- `bot:fixing` / `bot:preview-building` / `bot:awaiting-reporter` — the fix loop: building a candidate, publishing its preview, and waiting for the reporter to confirm it.
- `bot:blocked` / `bot:failed` — the bot stopped for a human decision, or a run errored; the reason is in its comment.

If an issue carries one of these, a bot investigation has happened or is in flight — read the bot's comments before starting a manual reproduction. `bot:awaiting-reporter` in particular means a candidate fix and preview already exist, so testing that fix beats re-reproducing the original bug. Double-checking the bot's conclusions is itself valuable triage: a human confirming or refuting a `bot:reproduced` or `bot:not-reproduced` verdict is worth more than the label.

(You may still see older `triage/*` labels on issues filed before the switch to `bot:*`; treat them as historical.)

## PR Triage

First, decide whether the PR is something the project accepts. The full policy is in [CONTRIBUTING.md § Contribution Policy](CONTRIBUTING.md#contribution-policy); in short:

Accepted directly:

- Bug fixes with a reproducing test.
- Documentation fixes and typos.
- Translation PRs from native or fluent speakers.

Needs prior maintainer approval via a Discussion:

- Features.
- Large refactors.
- Dependency upgrades outside Renovate/Dependabot.
- Broad cleanup PRs.

Normally closed without merging:

- Features with no Discussion or maintainer approval.
- New plugins. These should be published independently.
- Drive-by PRs (usually from bots) that aren't from people who are using EmDash.

Approval usually happens in Discussions: when a maintainer approves a proposal, the Discussion gets the `Approved for PR` label. But don't be pedantic about the mechanism — even if CI complains about a missing Discussion, a maintainer approving the idea in a PR or issue comment counts just as well, and maintainers can bypass the requirement entirely. What matters is whether a maintainer has said yes somewhere, not where they said it.

Two things to calibrate on:

- **The larger the feature, the more discussion it needs.** A small, obviously-useful addition might get a quick yes in a comment; a new subsystem or a change in project direction needs a real Discussion where the design gets worked through.
- **Opening a Discussion is not the same as it being approved.** A PR opened alongside its Discussion — or linking to one no maintainer has responded to — hasn't met the bar. The point is to get a yes _before_ the work, so wait for maintainer approval on the Discussion before treating the PR as reviewable.

If there's no sign of approval anywhere, add `needs-discussion` and leave a comment like:

```markdown
Thanks for the PR. This looks like a feature/change in project direction, so it needs an approved Discussion before review. Could you open one in Discussions and link it here? That helps avoid asking contributors to invest in work that may not fit the roadmap.
```

### What To Look For Before Review

The bot does code-level review and is good at it, but it's not perfect. The most useful human checks are the ones the bot gets wrong or can't judge:

- Is the PR template filled out?
- Does the PR explain _why_ the change is needed, and does that reason hold up?
- For bug fixes, is there a test that would fail without the fix?
- For user-facing package behavior changes, is there a changeset, and is it well written? (See [Checking Changesets](#checking-changesets).)
- For admin UI changes, are user-facing strings localized and does the layout use RTL-safe classes?
- For UI changes, does the PR include screenshots of the rendered result?
- For feature/refactor/performance PRs, has a maintainer approved the idea — a linked Discussion labeled `Approved for PR`, or approval in a PR or issue comment?
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

Almost every label you'll see on a PR is applied and removed by a workflow. You read them to scan the queue; you don't manage them:

- `review/needs-review`, `review/awaiting-author`, `review/needs-rereview`, `review/approved` — four mutually exclusive review states, kept in sync with actual review activity.
- `needs-approval` — CI hasn't run because the workflows are waiting for maintainer approval, which is normal for first-time contributors. Despite the name, it has nothing to do with Discussion approval.
- `needs-rebase` — the branch has merge conflicts with `main`.
- `overlap` — another open PR touches the same files; the bot leaves a comment identifying it.
- `stale` — no activity for two weeks. Stale PRs are closed automatically after three; a comment from you can keep a promising one alive.
- `size/*`, `area/*`, `bot`, and the CLA labels are applied when the PR is opened or updated.

The labels you apply by hand on a PR:

- `bot:review` to summon a bot re-review.
- `needs-discussion` when a feature/refactor PR has no maintainer approval anywhere.
- `blocked` when progress depends on another issue, PR, or maintainer decision.

## Discussions

Discussions is where ideas get shaped before they become work, and where a lot of community support happens. Triage there is just as valuable as on issues and PRs:

- **Answer Q&A questions when you can**, and mark the accepted answer so the next person searching finds it. A marked answer turns a one-off reply into documentation.
- **Weigh in on Ideas.** You know this project from contributing to it, and a comment like "this would conflict with how revisions work" or "I'd use this, and here's my use case" is exactly what a maintainer needs when deciding whether to approve a proposal. Don't hold back because approval isn't your call — shaping the proposal is how you help it get there.
- **Convert misfiled issues.** A feature request opened as an issue can be converted to an Ideas Discussion directly (the "Convert to discussion" option in the issue sidebar) — friendlier than asking the author to repost.
- **Connect the dots.** Link related Discussions, issues, and prior proposals. Many ideas have been discussed before, and a link to the earlier thread saves everyone from re-litigating it.
- **Surface proposals that look ready.** If an Idea has a worked-through design and community support but no maintainer response, raise it in `#triage`.

The one thing that stays with maintainers is the decision itself: `Approved for PR` on a Discussion is a maintainer call.

## Area Labels

On PRs, area labels are applied automatically from the changed file paths. On issues they are a human call — useful when they are obvious, but not the main goal of triage. Do not spend much time guessing; a clear comment and a good priority label are usually worth more than a perfect area label.

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

To escalate, post in `#triage` on Discord or @-mention a maintainer in a comment on the thread, and say what decision is needed. Ask a maintainer to step in when:

- A report involves data loss, security, auth bypass, or production outage risk.
- A contributor is proposing a breaking change.
- A PR changes database migrations or content table behavior in a way you are unsure about.
- A discussion turns argumentative.
- A contributor needs a product or roadmap decision.
- You are not sure whether closing would be fair.

Escalating is a normal outcome of triage, so don't worry if you need to.

**Security reports should not be debugged in public.** If an issue appears to describe a vulnerability, don't ask for exploit details in the thread. Ask the reporter to resubmit through [private vulnerability reporting](https://github.com/emdash-cms/emdash/security/advisories/new) (the "Report a vulnerability" button on the Security tab), close the issue and flag it in `#triage`.

## Useful Links

- [EmDash Discord](https://discord.gg/YY9vBaQRYt) — `#triage` is home base
- [Contributing guide](CONTRIBUTING.md)
- [Architecture and code patterns](AGENTS.md)
- [Documentation](https://docs.emdashcms.com)
- [Discussions](https://github.com/emdash-cms/emdash/discussions)
- [Issues](https://github.com/emdash-cms/emdash/issues)
- [Pull requests](https://github.com/emdash-cms/emdash/pulls)
