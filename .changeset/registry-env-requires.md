---
"@emdash-cms/registry-client": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/admin": minor
"emdash": minor
---

Registry plugins can now declare environment requirements. A plugin's manifest may set a release-level `requires` block (e.g. `{ "env:emdash": ">=1.0.0", "env:astro": ">=4.16" }`), which is published into the release record. When browsing a registry plugin, the admin compares those constraints against the running EmDash and Astro versions: if the host doesn't satisfy them, it shows a compatibility warning and disables the Install button. The server enforces the same check on install and update, refusing an incompatible release with `ENV_INCOMPATIBLE` so the gate can't be bypassed.
