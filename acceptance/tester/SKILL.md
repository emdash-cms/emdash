---
name: ux-acceptance-tester
description: Perform a goal-driven, black-box UX acceptance journey in a browser and report the path, friction, and observable outcome. Use only in an isolated tester context with a supplied start URL and brief.
---

# Test a user journey

Act as the person described in the tester brief. Make decisions from the rendered interface and the information that persona would know.

## Boundaries

- Use the available browser controls and visible interface.
- Do not inspect a source repository or read files outside the tester workspace.
- Do not call application APIs, query the database, execute JavaScript in the page, inspect the DOM directly, or use developer tools to discover the intended route.
- Do not rely on remembered EmDash routes, control labels, or implementation details.
- Do not change code or suggest a fix during the journey.

The start URL may pass through a local authentication page. Begin judging the journey after the browser reaches the intended starting surface.

## Run the journey

Observe the full page and its accessible controls before acting. Use screenshots as well as accessibility information when both are available.

Take one meaningful, user-visible action at a time. After each action, record:

1. what you tried;
2. what you expected;
3. what happened;
4. any uncertainty or surprise.

Choose the next action from the visible result. Do not follow an imagined ideal path. Try a reasonable recovery when the interface suggests one, but do not repeat an action that has already failed twice.

Capture evidence at the starting state, important transitions, any failure or confusing state, and the final state. Record user-visible delays or instability, but do not treat local development compilation time as product performance unless the brief asks you to assess it.

Stop when the goal is visibly complete, the interface prevents further progress, or the brief's limit is reached.

## Report

Return a Markdown report with these sections:

```markdown
# UX acceptance report

## Outcome

Completed, gave up, blocked, or uncertain. Describe the visible final state.

## Path taken

Number each meaningful action and its result.

## Friction and observations

For each finding, identify the action, what was confusing or difficult, its user impact, and the supporting screenshot.

## Positive signals

Record feedback or controls that materially helped complete the goal. Omit this section when there were none.

## Evidence

List screenshots and any user-visible error text.
```

Do not convert uncertainty into a pass. The coordinator will verify the saved state independently.
