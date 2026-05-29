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
6. **Rate confidence honestly.**
   - **High** -- the root cause is mechanical and obvious. There is one line or a tightly-scoped block that, when changed in a specific way, would fix the bug without ambiguity. A junior engineer pointed at this code would arrive at the same fix.
   - **Medium** -- you have identified the right code, but the correct fix involves design choices (which behaviour is the right one, whether to add a new parameter, whether to change the contract). A maintainer needs to decide before code is written.
   - **Low** -- there are multiple plausible causes and you cannot rule them out without instrumentation or further testing. Or the candidate code is the right area but no specific bug is visible in it.
     Rate down, not up. The fix stage only runs at `high`; over-rating produces wasted runs and rejected diffs.
7. **Write hypothesis notes when confidence is below high.** What else might be going on? What would you test to find out? This is the most valuable part of the comment for a maintainer reading a `medium` or `low` diagnosis.

## Output

Return:

- A root cause: the file path with approximate line number (e.g. `packages/core/src/api/handlers/menus.ts:142`), followed by prose explaining what is wrong and why it produces the reported symptom.
- A confidence rating: `high`, `medium`, or `low`.
- Hypothesis notes: empty if confidence is `high`; otherwise a short paragraph listing the alternative causes you considered and what would distinguish them.

Be specific. "Probably in the menu code somewhere" is not a diagnosis. "`resolveContentUrl` in `packages/core/src/menus/index.ts:87` issues three queries per item and the third is the missing-locale fallback path -- on a primary-locale request it is dead code, but it still runs" is.
