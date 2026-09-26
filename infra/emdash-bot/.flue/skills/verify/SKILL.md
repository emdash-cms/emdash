---
name: verify
description: Decide whether the diagnosed behaviour is actually a bug or the code doing what it was designed to do. This is the gate that guards the fix stage.
---

# Verify

Diagnose found code that explains the symptom. That does not make the code wrong. Plenty of EmDash issues describe behaviour that is intentional but under-documented, surprising at first glance, or a misuse of the API. Tell the difference -- fix runs only when you say `bug`.

You read code, comments, docs, tests, and `AGENTS.md`. You **modify nothing.** No edits, no test runs, no dev servers.

## Environment

Pure inspection -- **entirely VFS work.** Use `read_file`, `ls`, `grep`, and `code` to cross-reference code, docs, and tests. Do not attach a container.

## Do not

- No edits, no `git commit`, no `git push`.
- No GitHub writes. Read-only API GETs only.
- No network beyond the clone and the proxy-signed GitHub API.
- Touch no issue other than the one being investigated.

## Procedure

1. **Re-read the diagnose output.** The file, the line range, the prose. Hold it in mind as you cross-reference.
2. **Read the surrounding code, not just the line.** Comments immediately above and below; the function's docstring/JSDoc; its name and signature (often documents intent); adjacent branches and other call sites.
3. **Cross-reference documentation.** `AGENTS.md` and `CONTRIBUTING.md` for repo-wide rules (SQL safety, locale filtering, RBAC, request caching, query-count budget); `docs/` for user-facing behaviour that may be intentional; the package README or top-level docstring.
4. **Cross-reference tests.** An existing test asserting the current behaviour means it is intentional -- unless the test itself is wrong. Open it, read what it asserts and why. A test named for the diagnosed function is the strongest intent signal the repo has.
5. **Decide -- three verdicts only:**
   - **bug** -- behaviour matches the code, the code does _not_ match documented or clearly implied intent, and the reporter's expectation is reasonable. (Missing `locale` filter; off-by-one pagination; a 500 where a 404 belongs; a permission check admitting the wrong actor.)
   - **intended-behavior** -- behaviour matches the code, and the code matches documented intent. (`{ items, nextCursor }` not a bare array; the `X-EmDash-Request` CSRF header requirement; slugs unique per-locale not globally per migration 019; a maintainer-only endpoint returning 403 to authors.)
   - **unclear** -- docs are silent and intent cannot be inferred. Maybe a bug, maybe not; the maintainer decides.
6. **Resist two failure modes.** Do not call `intended-behavior` just because a test exists -- a test asserting wrong behaviour is part of the bug. Do not call `bug` just because the reporter is upset -- frustration is not a verdict.
7. **Explain, with citations.** One or two short paragraphs per verdict, citing the specific comment, doc section, or test by path. For `intended-behavior`, state the documented intent explicitly so the bot's comment can point the reporter at it ("I think this is by design -- see `<doc>` / `<test>` -- happy to revisit if you disagree"). For `unclear`, list what you would need to know to decide.

## Output

Return:

- Verdict: `bug`, `intended-behavior`, or `unclear`.
- Reasoning: prose supporting the verdict, with paths to the comments, docs, or tests you relied on. A verdict without a citation is confident noise -- cite or downgrade.

The workflow uses your verdict as a gate. `bug` triggers fix only when diagnose also pinned the cause (confidence not `low`), rated the fix `mechanical` or `clear-best-option`, _and_ the maintainer directive is a fix directive. A `bug` needing a design decision, an `unclear`, or `intended-behavior` all stop here and produce a comment-only outcome.
