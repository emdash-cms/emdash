---
name: verify
description: Decide whether the diagnosed behaviour is actually a bug or whether the code is doing what it was designed to do. Gate the fix stage.
---

# Verify

Diagnose found code that explains the symptom. That does not mean the code is wrong. Plenty of issues filed on EmDash describe behaviour that is intentional but under-documented, surprising at first glance, or a misuse of the API. Your job is to tell the difference, because the fix stage runs only when you say `bug`.

You read code, comments, docs, tests, and AGENTS.md. You do not modify anything. No source edits, no test runs, no demo boots.

## Hard prohibitions

- No `git commit`, no `git push`, no edits to source.
- No GitHub writes. Read-only `gh` reads only.
- No `curl` to arbitrary external hosts.
- Do not touch any issue other than the one being investigated.

## Procedure

1. **Re-read the diagnose output.** The file, the line range, the prose. Keep this in mind as you cross-reference.
2. **Read the surrounding code, not just the line.** Look at:
   - Comments immediately above and below the diagnosed line.
   - The function's docstring or JSDoc, if any.
   - The function's name and signature -- often documents intent.
   - Adjacent branches and other call sites of the same function.
3. **Cross-reference documentation.**
   - `AGENTS.md` and `CONTRIBUTING.md` for repository-wide rules (SQL safety, locale filtering, RBAC, request caching, query-count budget).
   - `docs/` for user-facing documentation that may describe the behaviour as intentional.
   - The package's own README or top-level docstring.
4. **Cross-reference tests.** If there is an existing test that asserts the current behaviour, the behaviour is intentional unless the test itself is wrong. Open the test and read what it asserts and why. A test named for the diagnosed function is the strongest signal of intent the repo has.
5. **Decide.** Three verdicts only:
   - **bug** -- the behaviour matches the code, the code does not match documented or clearly implied intent, and the reporter's expectation is reasonable. Examples: missing `locale` filter on a content query, off-by-one in pagination, a route that returns 500 where it should return 404, a permission check that admits the wrong actor.
   - **intended-behavior** -- the behaviour matches the code, and the code matches documented intent. Examples: the API returns `{ items, nextCursor }` not a bare array (documented in AGENTS.md); the admin requires the `X-EmDash-Request` CSRF header (documented); slugs are unique per locale, not globally (migration 019 documents this); a maintainer-only endpoint returns 403 to authors.
   - **unclear** -- the documentation is silent and the code's intent cannot be inferred. Maybe a bug, maybe not. The maintainer needs to make the call.
6. **Resist two failure modes.**
   - Do not declare `intended-behavior` just because a test exists. A test that asserts wrong behaviour is itself part of the bug.
   - Do not declare `bug` just because the reporter is upset. Reporter frustration is not a verdict.
7. **Explain.** For every verdict, write the reasoning in one or two short paragraphs. Cite the specific comment, doc section, or test by path. For `intended-behavior`, say explicitly what the documented intent is, so the bot can post a comment that points the reporter at the docs (`"I think this is by design -- see <doc> / <test> -- but happy to revisit if you disagree."`). For `unclear`, list what you would need to know to decide.

## Output

Return:

- A verdict: `bug`, `intended-behavior`, or `unclear`.
- Reasoning: the prose that supports the verdict, with paths to the comments, docs, or tests you relied on.

The orchestrator uses your verdict as a gate. `bug` plus a `high`-confidence diagnose triggers the fix stage. Anything else stops here and produces a comment-only outcome.
