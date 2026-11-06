---
"emdash": patch
---

Fixes CLI dev authentication creating `dev@emdash.local` before first-run setup and blocking the setup wizard with “Admin user already exists”. Dev authentication now requires completed setup; finish the wizard first or explicitly skip it with `/_emdash/api/setup/dev-bypass`.

If an earlier version has already left your development site blocked by this error, opening `/_emdash/api/setup/dev-bypass` under `astro dev` completes setup using the existing dev account. This skips the wizard rather than replacing the dev account with a personal account.
