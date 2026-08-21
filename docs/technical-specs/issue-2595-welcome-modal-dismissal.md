# Keep the Playground welcome dialog dismissed

Status: Implemented
Issue: [#2595](https://github.com/emdash-cms/emdash/issues/2595)
Base: `353ff4fd2e052e1a60ec31b92bdcd6024401997a`

## Summary

The Playground welcome dialog returned after a user dismissed it and then reloaded the admin or toggled Edit mode. Each reload received the fixed Playground administrator without the `data` stored in that Playground session, so `GET /_emdash/api/auth/me` reported `isFirstLogin: true` again.

For Playground requests, the endpoint now reads the persisted user data before calculating `isFirstLogin`. The dialog appears once in a new Playground session and stays dismissed after manual reloads and Edit-mode reloads.

## Scope

This change:

- keeps the welcome dialog dismissed within the same Playground session;
- preserves the existing behavior for passkey and external-auth users;
- preserves the page reload used to enter and leave Edit mode; and
- keeps the successful `/_emdash/api/auth/me` response shape unchanged.

It does not redesign the dialog, add client-side fallback state, change Playground reset or expiry, add a migration, or change authorization.

## Cause

`POST /_emdash/api/auth/me` already stores `welcomeDismissed: true` in the user's `data` JSON column. Normal authentication loads that data from the database on each request.

Playground middleware instead injects a module-scope `PLAYGROUND_USER` containing only `id`, `email`, `name`, and `role`. The GET endpoint previously read `locals.user.data` directly, so every Playground reload looked like a first login. The existing regression test hid this behavior by refreshing its user fixture before the final GET.

## Design

When `locals.__playgroundDb` is present, `GET /_emdash/api/auth/me` uses `UserRepository` with `emdash.db` to read the current user's persisted `data`. The runtime database getter is already scoped to the current Playground Durable Object.

Normal authenticated requests continue using `locals.user.data`, so they add no query. The Playground path adds one indexed user-row lookup to `GET /_emdash/api/auth/me`; logged-out routes and Edit-toggle handlers add none.

The fixed module-scope user is never mutated or cached with session state. One Playground session therefore cannot suppress the dialog in another session, and Worker restarts do not lose the persisted flag.

If the Playground lookup throws, the endpoint returns status 500 with `CURRENT_USER_ERROR` and `Failed to fetch current user`. The response does not expose the database error. If the initialized database has no matching user row, the endpoint retains the first-login result.

## Behavior

- A new Playground session returns `isFirstLogin: true` until dismissal succeeds.
- A successful dismissal stores `welcomeDismissed: true` before returning.
- Manual reloads and Edit-mode reloads in that session return `isFirstLogin: false`.
- Resetting or replacing the Playground session creates a different database, so the dialog can appear once for that session.
- `POST /_emdash/api/auth/me`, toolbar behavior, cookies, authorization, cross-site request forgery protection, localization, and layout remain unchanged.

## Tests

`packages/core/tests/unit/auth/me-welcome-dismiss.test.ts` uses the real SQLite test database to verify:

- the same data-less Playground user object reports `isFirstLogin: false` after dismissal; and
- a failed Playground lookup returns the redacted `CURRENT_USER_ERROR` response.

The first regression fails on the previous implementation because the endpoint reads the stale object. The tests do not mock the database.

Manual Playground verification covers:

1. Open a new session and dismiss the welcome dialog.
2. Reload the admin and confirm the dialog stays closed.
3. Toggle Edit mode on and off and confirm the dialog stays closed after both reloads.
4. Reset the Playground and confirm the new session shows the dialog once.
5. Dismiss with the close button, reload, and confirm the dialog stays closed.

## Files and release

The implementation changes:

- `packages/core/src/astro/routes/api/auth/me.ts`;
- `packages/core/tests/unit/auth/me-welcome-dismiss.test.ts`; and
- `.changeset/fix-playground-welcome-dismissal.md` with a patch release for `emdash`.

No locale catalogs, query-count snapshots, lockfiles, database schema, admin components, or toolbar files change.

## Verification

Run these checks from the repository root:

```sh
pnpm --filter emdash test tests/unit/auth/me-welcome-dismiss.test.ts
pnpm --filter emdash typecheck
pnpm lint:json | jq '.diagnostics | length'
pnpm format:check
pnpm --dir docs build
git diff --check
```

The implementation is complete when the automated tests and manual Playground sequence pass, normal authentication retains its existing path, and the branch contains only the files listed above plus this specification.
