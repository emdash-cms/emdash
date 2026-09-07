---
name: repro-public
description: Reproduce a bug in the public-facing rendered site (not the admin). Attach a container, start the demo dev server, drive public routes with agent-browser, and capture the reproduction as screenshots plus a replayable transcript.
---

# Reproduce: Public Site

The bug is in the rendered public site -- Astro pages outside `/_emdash`, the SSR output a visitor sees, public routing, sitemap, RSS, image rendering, or query patterns anonymous readers hit. No admin session needed. Reproduce and confirm entirely through `agent-browser`: the durable artifacts are your screenshots, a captured DOM slice, and a precise, replayable transcript. **Do not write Playwright or any other browser test** -- you cannot run one reliably here. The regression test belongs to whoever lands the fix.

## Environment

The dev server, `agent-browser`, and any CLI seeding run in an **attached container** (node + browser; neither exists in the isolate). Read the issue and grep the source in the isolate first, then attach the container for the reproduction.

## Do not

- No `git commit`, `git push`, or branch creation.
- No GitHub writes. Read-only API GETs only.
- No network beyond `localhost` (the demo) and the proxy-signed GitHub API.
- Touch no issue other than the one being investigated.

## Procedure

1. **Re-read the issue (isolate).** Note the exact URL or route pattern, expected-vs-actual output, and any headers or query strings that mattered. Public-site bugs often hinge on the locale, the requested format (HTML vs RSS), or specific content rows -- be precise.
2. **Pick a demo.** `demos/simple` is the default. For a locale-specific bug, pick a demo with multiple locales seeded; for a collection-specific bug, one that already has that collection.
3. **Seed content only if necessary.** If the repro needs a content item the seed lacks, create it with the CLI in the container: `pnpm exec emdash content create <collection> --data '...'` (see the `emdash-cli` skill for exact flags). Prefer ephemeral CLI-created content over editing seed files -- it disappears with the Workspace.
4. **Attach a container and start the demo dev server.** Astro 7 backgrounds dev servers natively -- from the demo directory run `astro dev --background` (e.g. `pnpm --filter ./demos/simple exec astro dev --background`). It detaches, enables JSON logging, and returns once the server is up, so you do not poll or improvise process management. Read the URL/port/PID and readiness from the `.astro/dev.json` lock file or `astro dev status`; Astro serves on `localhost:4321`. Tail output with `astro dev logs --follow`. If the server never comes up, capture `astro dev logs` and treat it as a setup failure. Stop it with `astro dev stop` when done (or leave it -- it dies with the container).
5. **Open the affected route.** `agent-browser open "http://localhost:4321/<path>"` with the exact path from the issue. Include any query string or `Accept` header the issue calls out.
6. **Inspect the rendered output.** `agent-browser snapshot -i -c` for the accessibility tree; `agent-browser get text @e<n>` to extract a region. For RSS or other non-HTML output, fetch it through the browser's network panel rather than `curl` -- the browser follows the demo's Astro routing the way a visitor does.
7. **Check for runtime errors.** `agent-browser console` for hydration warnings, missing data, or 404 sub-requests; `agent-browser errors` for exceptions thrown during render or hydration.
8. **Screenshot at meaningful states.** Save to `.bot-artifacts/step-<n>.png`: one of the page as loaded, one of the broken element if visible.
9. **Confirm the failure mode matches.** Public-site bugs are easy to misidentify -- rendering differences can come from missing seed data, a stale build artifact, or an unrelated route. If you cannot produce exactly the reported symptom, say so. Write the exact replayable steps (URL, any query string or `Accept` header, observed-vs-expected) so a maintainer can follow without you.

## When to skip

Mark skipped, with the reason, when:

- The bug needs a specific crawler user-agent, OG-card validator, or third-party fetcher you cannot impersonate from `localhost`.
- The bug needs production-scale content (pagination edge cases, sitemap chunking) the demo cannot realistically produce in run time.
- The bug only manifests on a deployed Worker -- CF edge cache headers, geographic routing, image transformation through the production R2 binding.
- The bug needs a specific source dataset (e.g. a WordPress import) the reporter did not attach.

## Output

Return:

- Whether you reproduced the bug.
- Whether you skipped, and the reason if so.
- The approach: `agent-browser-only` or `none`.
- Notes: the demo used, the exact URL, the interaction sequence in plain prose, and any console or runtime errors.
- A list of screenshots, each with its `.bot-artifacts/` filename and a one-line description.

A "could not reproduce" result backed by the transcript and screenshots is a valid, useful outcome -- return it as one.
