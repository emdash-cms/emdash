---
name: agent-browser
description: Use the agent-browser CLI to exercise web interfaces, inspect rendered accessibility state, verify interactions, and capture screenshots. Use for browser-based UI testing and evidence collection. Do not use as a substitute for deterministic Playwright coverage when an automated regression test is the requested deliverable.
---

# Test interfaces with agent-browser

Use the installed `agent-browser` CLI for rendered, user-facing verification. Load its version-matched instructions before relying on command syntax:

```bash
agent-browser skills get core --full
```

Use a specialized bundled guide when the target requires one. `agent-browser skills list` shows the available guides.

## Verification loop

1. Start or identify the target application and record the exact URL and viewport.
2. Open the page in a named session.
3. Take an accessibility snapshot and identify controls by role, label, or snapshot reference.
4. Perform the user action.
5. Wait for the resulting state, then take a fresh snapshot. References can become stale after navigation or a substantial DOM update.
6. Verify the observable result, console errors, and relevant network behavior.
7. Capture screenshots when visual evidence helps establish the result.

For EmDash admin testing, authenticate through the development bypass rather than attempting to automate passkeys:

```bash
agent-browser open 'http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin'
```

Use `auth/dev-bypass` instead when setup is already complete.

## Interaction guidance

- Prefer role and label locators when they express the user-facing control clearly. Use snapshot references for efficient exploration.
- Re-snapshot after a dialog opens, a route changes, or content is replaced.
- Wait for a selector or visible state instead of adding a fixed delay unless timing itself is under test.
- Use a named session for flows that depend on cookies or storage. Close sessions that are no longer needed.
- Check `agent-browser console` and `agent-browser errors` when the UI behaves unexpectedly.
- Use `agent-browser network requests` when the result depends on a request or response boundary.

## Evidence

Record the path tested, inputs, viewport, expected result, actual result, and any console or request failures. For UI changes, capture the rendered result and before-and-after screenshots when the difference is otherwise ambiguous.

Save screenshots inside the task workspace with descriptive filenames. Inspect the saved image before reporting success; a completed screenshot command does not prove that the intended state was visible.

Browser exploration does not replace a regression test when stable automated coverage can protect the behavior. Convert a confirmed defect into the narrowest meaningful automated test when the task includes implementation.
