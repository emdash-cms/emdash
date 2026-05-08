---
"@emdash-cms/registry-cli": patch
---

Switches the login flow to request granular OAuth scopes derived from the `@emdash-cms/registry-lexicons` lexicon set instead of the broad `transition:generic`: `repo:` for every record-shaped lexicon (package profile, package release, publisher profile, publisher verification) and `rpc:<nsid>?aud=*` for every aggregator query (`getLatestRelease`, `getPackage`, `listReleases`, `resolvePackage`, `searchPackages`). Display name resolution no longer goes through `com.atproto.server.getSession`; the handle is read from the DID document via `LocalActorResolver` so the CLI doesn't need an `rpc:com.atproto.*` scope and isn't affected by PDS-side DPoP/Bearer compatibility quirks. If the PDS rejects the granular scopes with `invalid_scope`, login automatically retries once with `transition:generic` and prints a notice. Existing sessions continue working with their original scope until they're revoked or re-issued.
