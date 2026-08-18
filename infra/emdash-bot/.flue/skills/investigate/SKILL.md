---
name: investigate
description: Investigate a single EmDash issue end to end -- classify, choose a repro path, reproduce, diagnose, verify, and (only on an explicit maintainer fix directive) fix and confirm. Every verdict carries its evidence.
---

# Investigate an EmDash issue

You investigate one issue on `emdash-cms/emdash`. You run inside a durable Workspace filesystem owned by your agent. The EmDash source tree is hydrated into it at `/workspace/repo` -- that is your working root. The issue title, body, and any quoted comments are handed to you in your inputs; you do not need to fetch them.

You proceed through five stages: **classify -> reproduce -> diagnose -> verify -> (conditionally) fix**. The leaf skills carry the detail; this skill is the spine that decides which of them runs and in what order.

## The one rule that overrides everything: no confident noise

Every stage produces a verdict, and **every verdict carries its evidence** -- the exact commands you ran and the output they produced. A claim with no transcript behind it is not a finding, it is noise, and posting it is worse than saying nothing.

"I could not reproduce this" **with** a transcript of what you tried is a first-class success. "I could not reproduce this" with nothing behind it is a failure. The same holds for a diagnosis, a verify verdict, or a fix: if you cannot show the work, downgrade the claim to what you can show.

Two corollaries when you report:

- **"Reproduced" means you demonstrated the reported defect -- so demonstrate it.** A failing test you ran, an error in command output, a browser transcript: any one of these is a full demonstration, and it does **not** need to copy the reporter's steps -- a failing unit test that exercises the same defect a UI report describes is a full reproduction of the issue. When you have one, report `reproduced: true` without hedging. Time-box it: if a demonstration is not converging after a couple of angles, stop grinding and report the diagnosis.
- **A confident diagnosis without a confirming repro is its own verdict.** When you identified the reporter's defect but could not demonstrate it here (environment limits, browser-only path), report `rootCauseFound: true` with `reproduced: false` -- that is the `diagnosed` verdict, and it is different from `not_reproduced`, which says "I investigated and found nothing wrong (or something else)."
- **`rootCauseFound` means a located defect, not an explanation.** It requires a concrete flaw in this repo's current code -- file and mechanism -- that produces the reported misbehavior. "The behavior traces to X" is not a root cause when X is correct code, a since-fixed version, the reporter's environment, or infrastructure outside this repo: those are `reproduced: false, rootCauseFound: false`, with the explanation in the summary as a finding. If your "cause" implies no code change could fix it here, it is not a root cause.
- **Reproducing something is not reproducing the issue.** Investigations surface real adjacent findings -- a latent defect the reported behavior never triggers, an infrastructure symptom outside this repo, a different bug nearby. Those are valuable: put them in the summary as findings, with `reproduced: false` and `rootCauseFound: false` (you did not find _this issue's_ cause). The test is simple: is the failure you demonstrated the one the reporter described? Answer it honestly in `demonstratedReportedIssue`.
- **Distinguish "tried and could not" from "could not try."** If the issue is missing the details a reproduction attempt would need (versions, config, content shape, exact steps), report `verdict: "unclear"` and name precisely what is missing, instead of an empty `not_reproduced`. Decide this from the issue text **before** standing anything up: a build or dev server cannot recover details the report never contained, and grinding the toolchain against an underspecified report burns the whole run to prove nothing. Asking the reporter early is the correct, complete outcome for such an issue -- not a lesser one.

## Execution environment

Your Workspace tools are `read_file`, `write_file`, `edit_file`, `ls`, `grep`, and `code`, over a durable virtual filesystem holding the repo checkout. There is no shell and no git in the VFS.

- **`read_file` / `ls` / `edit_file` / `write_file` / `grep`** operate on the VFS directly. They are fast and cheap; use them for the overwhelming majority of the work.
- **`code`** runs a JavaScript snippet against the VFS for anything the flat tools can't express -- multi-file analysis, structured searches, tree walks. It is read-only: change files with `write_file`/`edit_file`.
- **`exec` runs in the Linux container.** That is where the shell, git, `node`, `pnpm`, `astro`, `vitest`, and `agent-browser` live -- and the only place. Container attach is the slow, heavyweight path; it is where you run the toolchain, and where any `git log`/`show`/`diff` archaeology happens against the container's native clone. For commit/PR metadata, the read-only GitHub API is often cheaper than attaching.
- **Dev servers background natively.** For an admin or public repro, start the demo with `astro dev --background` (`astro preview --background` since 7.2) -- it detaches, enables JSON logging, and returns once ready; check `astro dev status` / `.astro/dev.json`, tail `astro dev logs --follow`, stop with `astro dev stop`. No external process manager. The server persists for the lifetime of the attached container, so start it once and reuse it across steps.

The discipline: **VFS-first, container on demand.** Do every read, grep, and analysis in the VFS. Escalate to the container the moment -- and only the moment -- you need to install, build, run tests, drive a browser, or inspect git history. Each leaf skill states which path it needs; follow it.

The design target is that fewer than one investigation step in ten needs the container. If you find yourself in the container for grep or file reads, you are doing it wrong -- drop back to the VFS tools.

## GitHub access

You are **read-only on GitHub.** The issue text is in your inputs. If you need more (a linked PR, a referenced file at a ref, the full comment thread), use read-only GitHub API GETs -- they are proxy-signed and scoped to this repo. You cannot comment, label, react, edit, close, or open anything via the API; every write 403s. The Orchestrator DO posts the single outcome comment from your reported result -- do not attempt mid-run comments. Touch no issue other than the one you are assigned.

## Stage 1 -- Classify

Read the issue body and any quoted comments in your inputs.

1. **`kind`**: `bug`, `enhancement`, `documentation`, or `question`. Labels found on the issue are a hint, not ground truth -- a maintainer can mislabel and still trigger investigation.
2. **`area`**: `api`, `admin`, `public`, `migration`, `build`, or `other`.
   - `api` -- REST handlers (`packages/core/src/api/`), the CLI (`packages/core/src/cli/`), the MCP server, anything exercised without a browser.
   - `admin` -- the React SPA (`packages/admin`), anything under `/_emdash/admin/*`.
   - `public` -- the rendered public site (Astro pages outside `/_emdash`), routing, SSR output, query patterns anonymous readers hit.
   - `migration` -- migrations (`packages/core/src/database/migrations/`), schema registry, content tables.
   - `build` -- bundling, tsdown, Vite, type generation, package exports, monorepo wiring.
   - `other` -- infra, meta, anything that fits nothing above.
   - A migration or build bug that only _surfaces_ through the admin UI is classified by its underlying area, not the surface.
3. **`requiresBrowser`**: true when `area` is `admin` or `public`; false otherwise.

**If `kind` is not `bug`, stop here.** Return the classification with a one-line note on what kind of issue it is. Reproduce/diagnose/verify/fix do not run for enhancements, docs, or questions -- the DO posts a short acknowledgement, not a triage report.

## Stage 2 -- Reproduce

The expensive stages (reproduce onward) run only because a maintainer triggered this investigation. That trigger is the budget -- do the work properly, but do not wander.

**Gate first: is an attempt possible?** Before dispatching, check the issue against the repro skill's prerequisites. If the report lacks the concrete inputs an attempt needs -- affected version, relevant config, content shape, steps specific enough to replay -- settle now with `verdict: "unclear"` naming what is missing. Do not install, build, or boot a dev server hoping the gap closes; it cannot.

Dispatch on `area`:

- `api`, `migration`, `build`, `other` -> **`repro-api`** (no browser; prefer a failing vitest test).
- `admin` -> **`repro-admin`** (container + agent-browser via the dev-bypass session).
- `public` -> **`repro-public`** (container + agent-browser against public routes).

Each repro skill returns: whether it reproduced, the approach it used, a replayable transcript (commands + output, or the agent-browser step sequence + screenshots), and whether it is skipping (with the reason). Carry that forward unchanged.

- If reproduce **skips** (environment genuinely cannot trigger the bug): do not run diagnose or fix. Run verify only if the issue body plus a static read of the source is enough to form an opinion; otherwise return the classification plus the skip reason.
- If reproduce **fails to reproduce** (tried, could not, not skipped): still run diagnose. The issue text alone is often enough to name the code path, and a grounded guess beats silence -- diagnose lowers its own confidence to match.

## Stage 3 -- Diagnose

Follow **`diagnose`**. Feed it the repro transcript. It returns a root cause (file + approximate line + prose), a confidence rating in that _cause_, a fix approach (`mechanical`, `clear-best-option`, or `needs-design-decision`) rating the _fix_, a concrete proposed fix, and hypothesis notes on alternative causes. Confidence and fix approach are independent axes -- a confidently located bug with one obvious backwards-compatible change is `high` + `clear-best-option`.

## Stage 4 -- Verify

Follow **`verify`**. It reads the diagnosed code, its comments, the docs, `AGENTS.md`, and the related tests, and decides `bug`, `intended-behavior`, or `unclear`. This is the gate that stops the bot from "fixing" behaviour that is working as designed.

## Stage 5 -- Fix (conditional, maintainer-triggered)

Run **`fix`** only when **all** hold:

- The maintainer directive for this run is an explicit **fix** directive (not repro/diagnose-only).
- `verify.verdict === "bug"`.
- `diagnose.confidence !== "low"` (cause pinned to at least medium).
- `diagnose.fixApproach !== "needs-design-decision"` (fix is `mechanical` or `clear-best-option`).

Any other combination: stop after verify. Post the diagnosis (proposed fix, or the options for a design decision) and the verify reasoning; a human takes it from there.

**The fix loop does not open a PR.** Fix produces a verified change and hands it to `publish_candidate`, which updates only the issue's `bot/fix-<n>` candidate branch. The update triggers a **preview build** the workflow posts to the issue, and the reporter is asked to confirm it resolves _their_ case. **Only after the reporter confirms** does a draft PR open (carrying the repro test, referencing the issue). Reporter denial or silence reaps the branch. Nothing you do here lands on `main`; a maintainer reviews the eventual PR.

## Output

Return one structured result combining the classification, the repro result, the diagnose result, the verify result, and the fix result if it ran. Omitted stages are explicitly absent, not filled with placeholders. Keep prose factual: if you guessed, say so; if you skipped a stage, say why in one sentence. Every non-trivial claim names the command or file that backs it.
