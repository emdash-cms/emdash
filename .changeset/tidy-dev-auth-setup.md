---
"emdash": patch
---

Fixes CLI dev authentication creating `dev@emdash.local` before first-run setup and blocking the setup wizard with “Admin user already exists”. Dev authentication now requires completed setup; finish the wizard first or explicitly skip it under `astro dev` with `/_emdash/api/setup/dev-bypass?content=0`.

If an earlier version has already left your development site blocked by this error, opening `/_emdash/api/setup/dev-bypass?content=0` under `astro dev` completes setup using the existing dev account without adding sample content, bylines, or taxonomy terms. It still applies the seed's schema and structure. This skips the wizard rather than replacing the dev account with a personal account.
