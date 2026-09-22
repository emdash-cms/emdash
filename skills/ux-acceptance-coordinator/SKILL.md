---
name: ux-acceptance-coordinator
description: Coordinate black-box, agent-driven UX acceptance journeys against a disposable EmDash admin site. Use when preparing, dispatching, verifying, or reporting a manual browser journey performed by a separate tester agent. Do not use for deterministic Playwright tests or ordinary code review.
---

# Coordinate UX acceptance testing

Run a goal-driven browser journey with a tester that has no repository context. Keep site preparation, private success checks, and product diagnosis in the coordinator context.

## Prepare the run

1. Read the selected journey in `acceptance/journeys/`.
2. Check the journey's `status` and `requires` frontmatter. If its status is `needs-profile`, report the missing bootstrap requirements and stop. Do not substitute a simpler profile or relax the journey.
3. Read its site profile in `acceptance/sites/` and the portable tester instructions in `acceptance/tester/SKILL.md`.
4. Choose the journey's target. Use Node unless the journey or change under test requires the Cloudflare runtime.
5. Start one disposable site:

   ```console
   pnpm ux:site:start -- --target node --profile editorial-small
   ```

6. Keep the run ID, start URL, and run-data path from the command output. Never send the run-data file or API token to the tester.

## Isolate the tester

Create the tester outside the repository checkout. Give it only:

- the contents of `acceptance/tester/SKILL.md`;
- the journey's `Tester brief` section;
- the generated start URL;
- a writable location for its report and screenshots.

Do not give the tester `AGENTS.md`, repository skills, source files, route names, the coordinator checks, or implementation context. Do not describe a clean context as isolated when the selected agent mechanism still exposes the checkout. If the environment cannot create a separate context within the user's authorization, prepare the handoff and ask the user to launch it.

Use any agent implementation that provides browser control. Do not translate the brief into tool-specific click instructions.

## Verify and report

Wait for the tester to finish or explicitly give up. Preserve its action log, screenshots, and report without rewriting its observations.

Run the journey's `Coordinator checks` independently. Prefer a read-only public API with the local token in the run-data file; use direct database inspection only when the public surface cannot establish the result. The tester's claim is not proof of completion.

Classify the run as one of:

- `PASS`: the checks passed and the tester found no material friction.
- `PASS_WITH_FRICTION`: the checks passed and the tester found a concrete UX issue.
- `FAIL_PRODUCT`: the site remained usable, but the journey goal was not achieved.
- `FAIL_INFRASTRUCTURE`: bootstrap, browser control, or the local server prevented a meaningful attempt.
- `INCONCLUSIVE`: the available evidence cannot distinguish product and test failures.

Report the functional result separately from UX findings. Include the path taken, failed or confusing actions, evidence, and independent check results.

Stop the exact run after collecting evidence, even when the journey fails:

```console
pnpm ux:site:stop -- <run-id>
```

Keep the site running only when the user asks to inspect it further.
