---
name: investigate
description: Investigate a single EmDash issue end to end -- classify, choose a repro path, reproduce, diagnose, verify, and (only on an explicit maintainer fix directive) fix and confirm. Every verdict carries its evidence.
---

# Investigate an EmDash issue

You investigate one issue on `emdash-cms/emdash`. You run inside an `@cloudflare/computer` Workspace attached to the Orchestrator DO for this issue. The EmDash repo is cloned into the Workspace filesystem via `git.clone` (shallow) at `/workspace/repo` -- that is your working root. The issue title, body, and any quoted comments are handed to you in your inputs; you do not need to fetch them.

You proceed through five stages: **classify -> reproduce -> diagnose -> verify -> (conditionally) fix**. The leaf skills carry the detail; this skill is the spine that decides which of them runs and in what order.

## The one rule that overrides everything: no confident noise

Every stage produces a verdict, and **every verdict carries its evidence** -- the exact commands you ran and the output they produced. A claim with no transcript behind it is not a finding, it is noise, and posting it is worse than saying nothing.

"I could not reproduce this" **with** a transcript of what you tried is a first-class success. "I could not reproduce this" with nothing behind it is a failure. The same holds for a diagnosis, a verify verdict, or a fix: if you cannot show the work, downgrade the claim to what you can show.

## Execution environment

Your Workspace tools are `read`, `write`, `edit`, `ls`, and `exec`, over a SQLite-backed virtual filesystem.

- **`read` / `ls` / `edit` / `write`** operate on the VFS directly. Prefer them over shelling out to `cat`, `sed`, or `echo`.
- **`exec` runs in the isolate by default** (bash-in-isolate via just-bash). The isolate is fast and cheap and spins up instantly. Use it for the overwhelming majority of the work: `grep`/`rg`, `git log`/`show`/`diff`/`grep`, listing and slicing files, walking the tree -- anything that inspects the checkout without running the project's own toolchain.
- **The isolate cannot run the project.** There is no `node`, `pnpm`, `astro`, `vitest`, or browser there. When you need any of those, **attach a container** and run `exec` inside it. Container attach is the slow, heavyweight path -- it is where and only where you run `pnpm install`, `astro build`, the dev server, `vitest`, and `agent-browser`.
- **Dev servers background natively.** For an admin or public repro, start the demo with `astro dev --background` (`astro preview --background` since 7.2) -- it detaches, enables JSON logging, and returns once ready; check `astro dev status` / `.astro/dev.json`, tail `astro dev logs --follow`, stop with `astro dev stop`. No external process manager. The server persists for the lifetime of the attached container, so start it once and reuse it across steps.

The discipline: **isolate-first, container on demand.** Do every read, grep, and git inspection in the isolate. Escalate to a container the moment -- and only the moment -- you need to install, build, run tests, or drive a browser. Each leaf skill states which path it needs; follow it.

The design target is that fewer than one investigation step in ten needs a container. If you find yourself in a container for grep or file reads, you are doing it wrong -- drop back to the isolate.

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

**The fix loop does not open a PR.** Fix produces a verified change, committed and pushed to the issue's `bot/fix-<n>` candidate branch -- the only ref the push capability can update. The push triggers a **preview build** the workflow posts to the issue, and the reporter is asked to confirm it resolves _their_ case. **Only after the reporter confirms** does a draft PR open (carrying the repro test, referencing the issue). Reporter denial or silence reaps the branch. Nothing you do here lands on `main`; a maintainer reviews the eventual PR.

## Output

Return one structured result combining the classification, the repro result, the diagnose result, the verify result, and the fix result if it ran. Omitted stages are explicitly absent, not filled with placeholders. Keep prose factual: if you guessed, say so; if you skipped a stage, say why in one sentence. Every non-trivial claim names the command or file that backs it.
