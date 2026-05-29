---
name: repro-public
description: Reproduce a bug in the public-facing rendered site (not the admin). Boots a demo with bgproc, drives the public routes with agent-browser, and prefers a Playwright test under e2e/.
---

# Reproduce: Public Site

The issue is in the rendered public site -- Astro pages outside `/_emdash`, the SSR output a normal site visitor sees, public routing, sitemap, RSS, image rendering, or query patterns visible to anonymous readers. You do not need an admin session. The best outcome is a Playwright test under the root `e2e/` directory. The second-best is an `agent-browser` transcript with screenshots and a captured DOM slice.

## Hard prohibitions

- No `git commit`, no `git push`, no branch creation that survives the workflow.
- No GitHub writes. Read-only `gh` reads only.
- No `curl` to arbitrary external hosts. `localhost:4321` only.
- Do not touch any issue other than the one being investigated.

## Procedure

1. **Re-read the issue.** Note the exact URL or route pattern, the content the reporter expected versus what they saw, and any headers or query strings that mattered. Public-site bugs often depend on the locale, the requested format (HTML vs RSS), or the presence of specific content rows -- be precise.
2. **Pick a demo.** `demos/simple` is the default. If the issue is locale-specific, pick a demo with multiple locales seeded. If the issue is collection-specific, pick a demo that already has that collection.
3. **Seed content if necessary.** If the issue requires a content item that the demo seed does not provide, create it with the CLI: `pnpm exec emdash content create <collection> --data '...'` (consult `skills/emdash-cli/SKILL.md` if you need the exact flags). Avoid editing seed files -- ephemeral content created via CLI is enough to reproduce and disappears with the workspace.
4. **Start the demo.** Run `bgproc start -n demo -w -- pnpm --filter ./demos/simple dev`. The `-w` flag waits until the dev server opens a port before returning -- Astro listens on `localhost:4321`. Inspect progress with `bgproc logs -n demo` if it does not come up.
5. **Open the affected route.** `agent-browser open "http://localhost:4321/<path>"`. Use the exact path from the issue. If the issue mentions a query string or specific `Accept` header, include it.
6. **Inspect the rendered output.** `agent-browser snapshot -i -c` gives you the accessibility tree. `agent-browser get text @e<n>` extracts text from a region. For RSS or non-HTML output, fetch via the browser's network panel rather than `curl` -- the browser will follow the demo's Astro routing the same way a visitor does.
7. **Check for runtime errors.** `agent-browser console` for warnings about hydration, missing data, or 404 sub-requests. `agent-browser errors` for thrown exceptions during render or hydration.
8. **Screenshot at meaningful states.** Save to `.bot-artifacts/step-<n>.png`. One of the page as loaded, one of the specific broken element if it is visible.
9. **Prefer a Playwright test.** Add one to the root `e2e/` directory targeting `http://localhost:4321/<path>`. Name it for the issue: `test("reproduces #<number>: <short description>", ...)`. Assert the specific broken behaviour -- a missing element, a wrong text node, an unexpected status code. Run it and confirm it fails for the reported reason, not for setup noise. Playwright's chromium is already installed in this environment -- run the test directly and do not run `playwright install` (it can stall for many minutes on the browser download).
10. **Confirm the failure mode matches.** Public-site bugs are easy to misidentify because rendering differences can be caused by missing seed data, a cached build artifact, or an unrelated route. If you cannot produce exactly the symptom in the issue, say so in notes.

## When to skip

Mark `skipped: true` and explain in notes when:

- The bug requires a specific search engine crawler user-agent, OG card validator, or other third-party fetcher you cannot impersonate from `localhost`.
- The bug requires production-scale content (pagination edge cases, sitemap chunking) that the demo cannot realistically produce in workflow time.
- The bug only manifests on a deployed Worker -- caching headers from the CF edge, geographic routing, image transformation through the production R2 binding.
- The bug requires a specific source dataset (e.g. WordPress import) the reporter did not attach.

## Output

Return:

- Whether you reproduced the bug.
- Whether you skipped (with reason if so).
- The approach you used: `playwright-test`, `agent-browser-only`, or `none`.
- Notes: the demo used, the exact URL, the interaction sequence in plain prose, any console or runtime errors, the test file path if you wrote one.
- A list of screenshots, each with the relative filename under `.bot-artifacts/` and a one-line description.

Do not stage or commit the test you wrote. The fix stage may pick it up; if no fix runs, the orchestrator decides what to do with the working tree.
