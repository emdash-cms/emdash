# Investigation pipeline (reference document)

> **Not a Flue skill.** This document describes the four-stage
> pipeline implemented in `.flue/workflows/investigate.ts`. It is not
> loaded as a `SkillReference` and editing it has no runtime effect.
> The leaf skills the workflow does load are siblings of this file
> (`diagnose/SKILL.md`, `verify/SKILL.md`, `fix/SKILL.md`,
> `repro-api/SKILL.md`, `repro-admin/SKILL.md`, `repro-public/SKILL.md`).
> The leading underscore in the filename keeps this directory from
> being mistaken for a Flue skill directory by Vite's skill loader.

The bot investigates a single GitHub issue on `emdash-cms/emdash` that a maintainer flagged with the `bot:repro` label. It runs on a GitHub Actions runner with a clean EmDash checkout in the working directory. It walks a four-stage pipeline and returns one structured result that downstream code uses to post a comment on the issue.

You are read-only on GitHub. The `GH_TOKEN` available to bash has read scope only. You cannot comment, label, edit, close, or push branches from inside this skill. The orchestrator handles all writes after you return.

## Hard prohibitions

- No `git commit`. No `git push`. No `git tag`.
- No `gh pr ...` writes, no `gh issue comment`, no `gh issue edit`, no `gh issue close`. Read-only `gh` calls (`gh issue view`, `gh api` GETs) are fine.
- No `curl` to arbitrary external hosts. Stay on `localhost`, the GitHub API, the npm registry, and EmDash docs.
- Do not modify, label, or close any issue other than the one you are investigating, and even on that one your role is read-only.
- No `pnpm publish`. No `npm publish`. No changeset commits.

## Stages

You drive four stages in order. The first stage produces a classification that selects which reproduce sub-skill to load. The reproduce result then feeds into diagnose, then verify, then conditionally fix.

### 1. Read and classify

1. Use `gh issue view <number> --json number,title,body,labels,author,comments` to load the issue. Read the full body and the comment thread.
2. Decide `kind`: `bug`, `enhancement`, `documentation`, or `question`. Use the existing labels as a hint, not as ground truth -- a maintainer can mislabel and still flag for repro.
3. Decide `area`: `api`, `admin`, `public`, `migration`, `build`, or `other`.
   - `api` -- REST handlers under `packages/core/src/api/`, the CLI in `packages/core/src/cli/`, the MCP server, anything exercised without a browser.
   - `admin` -- the React SPA in `packages/admin`, anything served under `/_emdash/admin/*`.
   - `public` -- the rendered public site (Astro pages outside `/_emdash`), routing, SSR output, query patterns visible to anonymous readers.
   - `migration` -- database migrations in `packages/core/src/database/migrations/`, schema registry, content tables.
   - `build` -- bundling, `tsdown`, Vite, type generation, package exports, monorepo wiring.
   - `other` -- anything that doesn't fit, including infra issues, security disclosure replies, meta-discussion.
4. Decide `requiresBrowser`: true when `area` is `admin` or `public`. False otherwise. Migration or build issues that surface through the admin UI count as the underlying area, not the surface.
5. If `kind` is anything other than `bug`, you do not run the reproduce / diagnose / verify / fix stages. Return early with the classification and a note explaining what kind of issue this is. The orchestrator will post a short acknowledgement rather than a triage report.

### 2. Reproduce

Dispatch based on `area`:

- `api`, `migration`, `build`, `other` -> follow `../repro-api.md`.
- `admin` -> follow `../repro-admin.md`.
- `public` -> follow `../repro-public.md`.

Each reproduce sub-skill returns whether it managed to reproduce the failure, the approach it used (failing test, repro script, agent-browser session, or none), free-form notes, and any screenshots it captured. Carry that result forward unchanged.

If the reproduce stage returns `skipped: true`, do not run diagnose or fix. Run verify only if there is enough static evidence in the issue body and source to form an opinion -- if not, skip verify too and return the classification plus the skip reason.

### 3. Diagnose

Follow `../diagnose.md`. Feed it the reproduce notes. It returns a root cause (file plus approximate line plus prose), a confidence rating in that cause, a fix approach (`mechanical`, `clear-best-option`, or `needs-design-decision`), a concrete proposed fix, and hypothesis notes covering alternative causes. Confidence rates the _cause_; fix approach rates the _fix_ -- the two are independent, so a confidently-located bug whose fix is one clear backwards-compatible change is `high` + `clear-best-option`, not `medium`.

If the reproduce stage failed to reproduce (`reproduced: false`, not skipped), still run diagnose -- often the issue text alone is enough to identify the code path, and the bot's comment is more useful with a guess than without one. Diagnose should lower its own confidence accordingly.

### 4. Verify

Follow `../verify.md`. It looks at the diagnosed code, the surrounding documentation, and the related tests, and decides whether the behaviour is a bug, intentional, or unclear. This is the gate that prevents the bot from "fixing" something that is working as designed.

### 5. Fix (conditional)

Only run `../fix.md` when **all** of the following hold:

- `verify.verdict === 'bug'`
- `diagnose.confidence !== 'low'` (the cause is pinned with at least medium confidence)
- `diagnose.fixApproach !== 'needs-design-decision'` (the fix is `mechanical` or `clear-best-option`)

Any other combination: skip fix. The bot posts the diagnosis (including the proposed fix or, for a design decision, the options) and verify reasoning as a comment, and a human takes it from there. The gate is deliberately broader than the old `confidence === 'high'` rule, which conflated "is the cause certain?" with "is the fix obvious?" and starved the fix stage of real, fixable bugs. The output is not a merge -- it is a candidate branch the reporter is asked to verify and a maintainer reviews -- so a clear, test-backed fix is worth attempting even when it is more than a one-line change.

The fix stage runs on a cheaper model than the reasoning stages: diagnose has already produced a concrete plan, so fix is guided implementation rather than open-ended investigation. Carry its result forward. Fix returns whether the change actually built and tested clean, a conventional-commit-style message, the list of files changed, and notes. The orchestrator is responsible for committing and pushing -- you do not.

## Output

Return a single structured result combining the classification, the reproduce result, the diagnose result, the verify result, and the fix result if it ran. Omitted stages should be explicitly absent rather than filled with placeholders. Notes from each stage should be specific enough that a maintainer reading the eventual comment can follow what you did without re-running the pipeline.

Keep prose factual. If you guessed, say you guessed. If you skipped a stage, say why in one sentence.
