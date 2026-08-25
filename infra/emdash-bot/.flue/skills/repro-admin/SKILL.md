---
name: repro-admin
description: Reproduce an EmDash admin UI bug. Attach a container, start the demo dev server, drive the admin with agent-browser using the dev-bypass session, and capture the reproduction as screenshots plus a replayable transcript.
---

# Reproduce: Admin UI

The bug is in the React admin under `/_emdash/admin/*`. You need a running demo, an authenticated session, and a way to drive the UI through the reporter's steps. Reproduce and confirm entirely through `agent-browser`: the durable artifacts are your screenshots plus a precise, replayable transcript. **Do not write Playwright or any other browser test** -- you cannot run one reliably here, so an unrun test is unverified guesswork. The regression test belongs to whoever lands the fix.

## Environment

Everything in this skill runs in an **attached container** -- the dev server, `agent-browser`, and any CLI seeding all need node and a browser, none of which exist in the isolate. Do your issue-reading and any source grepping in the isolate first, then attach the container for the reproduction itself.

## Do not

- No `git commit`, `git push`, or branch creation.
- No GitHub writes. Read-only API GETs only.
- No network beyond `localhost` (the demo) and the proxy-signed GitHub API.
- Touch no issue other than the one being investigated.
- Do not modify Lingui catalogs (`packages/admin/src/locales/*/messages.po`) -- a workflow regenerates them on merge; touching them here is churn.

## Procedure

1. **Re-read the issue (isolate).** Note the exact steps, the page, the browser, and any screenshots or stack traces. If the steps reference a collection or content item, decide whether the default demo seed covers it or whether you must create content first.
2. **Pick a demo.** `demos/simple` is the default and covers most admin reproductions. Use a more specific demo only when the issue names one.
3. **Attach a container and start the demo dev server.** Astro 7 backgrounds dev servers natively -- from the demo directory run `astro dev --background` (e.g. `pnpm --filter ./demos/simple exec astro dev --background`). It detaches, enables JSON logging, and returns once the server is up, so you do not poll or improvise process management. Read the URL/port/PID and readiness from the `.astro/dev.json` lock file or `astro dev status`; Astro serves the demo on `localhost:4321`. Tail output with `astro dev logs --follow`. If the server never comes up, capture `astro dev logs` and treat that as a **setup failure, not a reproduction**. Stop it with `astro dev stop` when done (or just leave it -- it dies with the container).
4. **Get a session.** Point agent-browser at the dev-bypass endpoint: `agent-browser open "http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin"`. This runs migrations, creates the dev admin user (`dev@emdash.local`), sets a session cookie, and lands you on the admin home. The endpoint is gated to `import.meta.env.DEV`, so it exists only locally -- never against a deployed environment.
5. **Drive the UI.** `agent-browser snapshot -i -c` gives an accessibility tree with `@e<n>` refs. Interact with `click @e<n>`, `fill @e<n> "text"`, `select @e<n> "option"`. Refs are stable only within one snapshot -- re-snapshot after every navigation or DOM change.
6. **Screenshot at meaningful steps.** Save to `.bot-artifacts/step-<n>.png`: one on landing, one at the point the reporter says the bug appears, one of the broken state. Use `--full` only when the bug is below the fold. Keep file sizes reasonable.
7. **Watch for JS errors.** After each interaction run `agent-browser console` and `agent-browser errors`. React key warnings and unmounted-setState noise are almost never the bug; runtime exceptions usually are.
8. **Confirm the failure mode matches.** A different broken state is not a reproduction. If you can only reach an adjacent broken state, say so. Write the exact replayable sequence -- URL, refs/selectors, inputs, observed broken state -- so a maintainer can follow it without you.

## When to skip

Mark skipped, with the reason, when:

- The bug needs a browser engine agent-browser's headless Chromium cannot drive faithfully (rare; usually a Safari-specific layout quirk).
- The bug needs OS-level interaction beyond a headless browser -- native file pickers in non-trivial drag-drop, OS clipboard internals, IME flows, hardware key combos.
- The bug only reproduces with a real user's extensions or profile (a password manager or autofill injecting into inputs). A clean headless browser has none. Say so -- this is a real bug class the bot cannot trigger.
- The bug needs real Cloudflare Access in front of the admin. Dev-bypass skips Access; "Access redirects me incorrectly" is not locally reproducible.
- The repro depends on production data, third-party OAuth, or a hosted environment.
- The demo will not boot for an unrelated reason -- the failure is in setup, not the admin code.

## Output

Return:

- Whether you reproduced the bug.
- Whether you skipped, and the reason if so.
- The approach: `agent-browser-only` or `none`.
- Notes: a short paragraph naming the demo, the URL path where the symptom appeared, the interaction sequence in plain prose, and any console or runtime errors.
- A list of screenshots, each with its `.bot-artifacts/` filename and a one-line description.

A "could not reproduce" result backed by the transcript and screenshots of what you tried is a valid, useful outcome -- return it as one.
