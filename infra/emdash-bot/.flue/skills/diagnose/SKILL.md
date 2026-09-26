---
name: diagnose
description: Trace from a reproduced symptom to the source code that causes it. Pin the specific file and approximate line, rate confidence in the cause and clarity of the fix independently, and always propose a concrete fix.
---

# Diagnose

Reproduce handed you a symptom -- a failing test, a screenshot, a console error, a wrong HTTP response. Find the code that produces it and explain why, in enough detail that verify can decide whether it is a bug and fix can act if it is.

You **read code only.** No edits, no test runs, no dev servers. The working tree is identical when you finish.

## Environment

This is pure inspection, so it is **entirely VFS work.** Use `read_file`, `ls`, `grep`, and `code` to walk from symptom to source. Attach a container only if the diagnosis genuinely hinges on git history (`git log`/`show` run there); prefer the read-only GitHub API for commit and PR metadata.

## Do not

- No edits, no `git commit`, no `git push`.
- No GitHub writes. Read-only API GETs only.
- No network beyond the clone and the proxy-signed GitHub API.
- Touch no issue other than the one being investigated.

## Procedure

1. **Anchor on the repro transcript.** It already named a file, command, or URL -- start there. If reproduce was skipped, anchor on the file paths, error messages, or stack frames in the issue body.
2. **Walk from symptom to source.**
   - Thrown exception with a stack trace: read each frame in order from the deepest _application_ frame (not framework internals). Confirm the call sequence matches what reproduce actually executed.
   - Wrong return value: grep for the function that produced it, then trace its inputs back to where they enter the system (handler boundary, CLI entry, render call).
   - Wrong HTML or DOM: identify the component or Astro page that renders it, then check what data it consumes and where that data comes from -- the bug is often in the data layer, not the render layer.
   - Migration or schema bug: read the migration in question, the SchemaRegistry path that invoked it, and the surrounding migrations for ordering assumptions.
3. **Read the candidate code in full.** Do not skim. Read the whole function, the whole handler, the whole component -- bugs hide in adjacent branches.
4. **Check the recurring EmDash culprits first.**
   - Missing `locale` filter on a content-table query (a known recurring class).
   - SQL identifier interpolated unsafely instead of `sql.ref()` / `validateIdentifier()`.
   - Off-by-one in pagination cursor encode/decode.
   - Missing `await` on a promise whose result is ignored.
   - `noUncheckedIndexedAccess` undefined-handling patched with `!` that is now wrong.
   - Permission check missing or run on the wrong actor.
   - Lingui `t` called at module scope.
   - Physical Tailwind class (`ml-*`, `text-left`) where a logical one belongs.
5. **Pin the location.** The file and the smallest line range containing the bug. One line is ideal; a function-sized range is acceptable when the bug is structural. If you cannot get below file level, you do not have a diagnosis yet -- search more.
6. **Rate confidence in the root cause.** This axis is _only_ how sure you are you found the responsible code -- not how easy the fix is.
   - **High** -- traced symptom to a specific file and line range, mechanism explainable end to end; another engineer would agree.
   - **Medium** -- right area and a strong candidate, but the mechanism is unconfirmed (reproduce was skipped/failed, or a second plausible cause you cannot rule out by reading).
   - **Low** -- multiple indistinguishable causes, or the right area but no specific defect visible.
     Rate honestly both ways. Fix does not run at `low` but _does_ run at `medium` when the fix is clear -- do not reflexively rate down. A confidently located cause is `high` even when the fix involves choosing between options; that choice is the next field's job.
7. **Choose a fix approach (independent of confidence).**
   - **mechanical** -- one obviously-correct change: a line or tight block, no judgement (a missing `await`, a wrong operator, a missing `locale` filter).
   - **clear-best-option** -- bigger than a one-liner, or several shapes exist, but one is clearly right: backwards-compatible, matches existing patterns, confirmable by the repro test. Name it and say why it beats the alternatives. Sibling code in the same file is strong evidence of intent -- if one branch already does the right thing, mirroring it is `clear-best-option`, not a design decision.
   - **needs-design-decision** -- choosing correctly needs a maintainer's judgement: a new public API or option, a shared component that does not exist yet, a behavioural-contract change, or a security/performance tradeoff. Do not guess; lay out the options. Do not retreat here just because more than one fix is conceivable -- reserve it for when the _right_ choice genuinely belongs to a maintainer.
8. **Write the proposed fix, always.** For `mechanical` / `clear-best-option`: the specific change -- which file, what to add/remove/change, and how the repro test proves it -- concrete enough that fix can implement it without re-deriving your reasoning. For `needs-design-decision`: the viable options, the tradeoff that separates them, and your recommendation if you have one.
9. **Write hypothesis notes for alternative causes.** What _other_ root causes did you consider, and how did you rule them in or out? Empty only when the cause is genuinely unambiguous. This is the most valuable part of a `medium` or `low` diagnosis for the maintainer.

## Output

Return:

- Root cause: file path with approximate line (e.g. `packages/core/src/api/handlers/menus.ts:142`) plus prose on what is wrong and why it produces the symptom.
- Confidence in the cause: `high`, `medium`, or `low`.
- Fix approach: `mechanical`, `clear-best-option`, or `needs-design-decision`.
- Proposed fix: the concrete change, or the options a maintainer must choose between. Never empty.
- Hypothesis notes: alternative causes considered and what distinguishes them; empty only when unambiguous.

Be specific and carry your evidence. "Probably in the menu code somewhere" is not a diagnosis. "`resolveContentUrl` in `packages/core/src/menus/index.ts:87` issues three queries per item and the third is the missing-locale fallback -- on a primary-locale request it is dead code but still runs" is.
