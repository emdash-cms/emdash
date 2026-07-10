---
name: diagnose
description: Trace from a reproduced symptom to the source code that causes it. Identify the specific file and approximate line, then rate confidence honestly.
---

# Diagnose

The reproduce stage gave you a symptom -- a failing test, a captured screenshot, a console error, a wrong HTTP response. Your job is to find the code that produces that symptom and explain why, in enough detail that the verify stage can decide whether it is a bug and the fix stage can act if it is.

You read code. You do not modify it. No edits, no test runs, no demo boots. The state of the working tree should be the same when you finish as when you started.

## Hard prohibitions

- No `git commit`, no `git push`, no edits to source.
- No GitHub writes. Read-only `gh` reads only.
- No `curl` to arbitrary external hosts.
- Do not touch any issue other than the one being investigated.

## Procedure

1. **Anchor on the reproduce notes.** The reproduce stage already named at least one file, command, or URL. Start there. If reproduce was skipped, anchor on the file paths, error messages, or stack frames in the issue body.
2. **Walk from symptom to source.**
   - For a thrown exception with a stack trace: read each frame in order, starting from the deepest application frame (not framework internals). Confirm the call sequence matches what reproduce actually executed.
   - For a wrong return value: grep for the function that produced it, then trace its inputs back to where they enter the system (handler boundary, CLI entry point, render call).
   - For wrong HTML or wrong DOM: identify the component or Astro page that renders it. Check what data it consumes and where that data comes from -- often the bug is in the data layer, not the render layer.
   - For migration or schema bugs: read the migration file in question, the SchemaRegistry path that invoked it, and the surrounding migrations to understand ordering assumptions.
3. **Read the candidate code in full.** Do not skim. Read the whole function, the whole route handler, the whole component. Bugs hide in adjacent branches.
4. **Check the obvious culprits first.**
   - Missing `locale` filter on a content-table query -- a known recurring class.
   - SQL identifier interpolated unsafely.
   - Off-by-one in pagination cursor encoding or decoding.
   - Missing `await` on a promise whose return value is ignored.
   - `noUncheckedIndexedAccess` undefined-handling that was patched with `!` and is now wrong.
   - Permission check missing or invoked on the wrong actor.
   - Lingui `t` called at module scope.
   - Physical Tailwind class (`ml-*`, `text-left`) where a logical class belongs.
5. **Pin the location.** Identify the file and the smallest range of lines that contain the bug. A single line is ideal; a function-sized range is acceptable when the bug is structural. If you cannot get below file-level, you do not yet have a diagnosis -- search more.
6. **Rate your confidence in the root cause.** This axis is only about how sure you are that you have found the code responsible -- _not_ about how easy the fix is. Keep the two separate; the next step rates the fix.
   - **High** -- you traced the symptom to a specific file and line range and can explain the mechanism end to end. Another engineer reading your diagnosis would agree this is the cause.
   - **Medium** -- you have the right area and a strong candidate, but you could not fully confirm the mechanism (reproduce was skipped or failed, or there is a second plausible cause you cannot rule out by reading alone).
   - **Low** -- multiple plausible causes you cannot distinguish without instrumentation, or the candidate code is the right area but no specific defect is visible in it.
     Rate honestly in both directions. The fix stage does not run at `low`, but it _does_ run at `medium` when the fix is clear, so do not reflexively rate down -- a confidently-located cause is `high` even when the fix involves choosing between options. That choice is the next field's job, not this one's.
7. **Choose a fix approach.** This is independent of confidence. Judge how clear the _fix_ is, given the cause:
   - **mechanical** -- there is one obviously-correct change: a single line or tightly-scoped block, no judgement calls. (A missing `await`, a wrong comparison operator, a missing `locale` filter.)
   - **clear-best-option** -- the fix is bigger than a one-liner, or several shapes exist, but one is clearly the right call: it is backwards-compatible, matches patterns already in the codebase, and the reproduce test can confirm it. Name that option and say why it beats the alternatives. (Example: issue #1178 hard-codes `c.title` in a SELECT; probing the column list and selecting `title` only when it exists is backwards-compatible and matches the bug's shape, whereas every alternative either breaks the documented API or is a larger redesign. The sibling code in the same file is often direct evidence of intended behaviour -- if one branch already does the right thing, mirroring it is `clear-best-option`, not a design decision.)
   - **needs-design-decision** -- choosing correctly requires a judgement only a maintainer should make: a new public API or option, a shared component that does not exist yet, a behavioural-contract change, or a security / performance tradeoff. Do not guess; lay out the options.
     The fix stage runs for `mechanical` and `clear-best-option` and defers `needs-design-decision` to a human. Do not retreat to `needs-design-decision` just because more than one fix is conceivable -- reserve it for when the _right_ choice genuinely belongs to a maintainer.
8. **Write the proposed fix, always.** For `mechanical` / `clear-best-option`: describe the specific change -- which file, what to add/remove/change, and how the reproduce test proves it -- in enough detail that the fix stage can implement it directly without re-deriving your reasoning. (A cheaper model implements it; the more concrete your plan, the better the result.) For `needs-design-decision`: lay out the viable options and the tradeoff that distinguishes them, and name your recommendation if you have one. This becomes the maintainer's starting point.
9. **Write hypothesis notes for alternative _causes_.** Distinct from the proposed fix (which is about the remedy): what _other_ root causes did you consider, and how did you rule them in or out? Empty only when the cause is genuinely unambiguous. This is the most valuable part of the comment for a maintainer reading a `medium` or `low` diagnosis.

## Output

Return:

- A root cause: the file path with approximate line number (e.g. `packages/core/src/api/handlers/menus.ts:142`), followed by prose explaining what is wrong and why it produces the reported symptom.
- A confidence rating in the root cause: `high`, `medium`, or `low`.
- A fix approach: `mechanical`, `clear-best-option`, or `needs-design-decision`.
- A proposed fix: the concrete change to make (`mechanical` / `clear-best-option`) or the options a maintainer must choose between (`needs-design-decision`). Never empty.
- Hypothesis notes: the alternative _causes_ you considered and what distinguishes them; empty only when the cause is unambiguous.

Be specific. "Probably in the menu code somewhere" is not a diagnosis. "`resolveContentUrl` in `packages/core/src/menus/index.ts:87` issues three queries per item and the third is the missing-locale fallback path -- on a primary-locale request it is dead code, but it still runs" is.
