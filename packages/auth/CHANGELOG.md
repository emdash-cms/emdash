# @emdash-cms/auth

## 0.11.1

## 0.11.0

### Patch Changes

- [#893](https://github.com/emdash-cms/emdash/pull/893) [`f8ee1ed`](https://github.com/emdash-cms/emdash/commit/f8ee1ed5e7b02b8905ebec82fb703e3061fe8161) Thanks [@j-liszt](https://github.com/j-liszt)! - Enhances Passkey authentication with polymorphic algorithm support. Adds support for RS256 (RSA) alongside the existing ES256 (ECDSA) implementation, ensuring full compatibility with Windows Hello, hardware security keys, and FIDO2 standards. Includes a database migration to track and persist credential algorithms for future-proof authentication.

  Note for standalone `@emdash-cms/auth` consumers: If your `credentials` table already exists, you must manually run `ALTER TABLE credentials ADD COLUMN algorithm INTEGER NOT NULL DEFAULT -7` to support this update. The `DEFAULT -7` value ensures that existing rows (which are all ES256) continue to work seamlessly without requiring any data backfill.

## 0.10.0

### Patch Changes

- [#912](https://github.com/emdash-cms/emdash/pull/912) [`c8a3a2c`](https://github.com/emdash-cms/emdash/commit/c8a3a2cce6bfdcdc6521556bcc507f88bd79ba31) Thanks [@lsngmin](https://github.com/lsngmin)! - Permanent-delete API now refuses to remove live (non-trashed) rows and uses a content-domain `content:delete_permanent` permission instead of the unrelated `import:execute`. Existing audience (ADMIN-only) is unchanged.

## 0.9.0

### Minor Changes

- [#800](https://github.com/emdash-cms/emdash/pull/800) [`e2d5d16`](https://github.com/emdash-cms/emdash/commit/e2d5d160acea4444945b1ea79c80ca9ce138965b) Thanks [@csfalcao](https://github.com/csfalcao)! - Adds support for accepting passkey assertions from multiple origins that share an `rpId`, for deployments reachable under several hostnames (apex + preview/staging) under one registrable parent. Declare additional origins via `EmDashConfig.allowedOrigins` (in `astro.config.mjs`) or the `EMDASH_ALLOWED_ORIGINS` env var (comma-separated); the two sources merge at runtime. EmDash validates the merged set against `siteUrl` and rejects dead config (non-subdomain entries, IP-literal `siteUrl`, trailing dots, empty labels) with source-attributed errors. `PasskeyConfig.origin: string` is replaced by `PasskeyConfig.origins: string[]`.

## 0.8.0

### Minor Changes

- [#779](https://github.com/emdash-cms/emdash/pull/779) [`e402890`](https://github.com/emdash-cms/emdash/commit/e402890fcd8647fdfe847bb34aa9f9e7094473dd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `settings_get` and `settings_update` MCP tools so agents can read and update site-wide settings (title, tagline, logo, favicon, URL, posts-per-page, date format, timezone, social, SEO). `settings_get` resolves media references (logo/favicon/seo.defaultOgImage) to URLs; `settings_update` is a partial update that preserves omitted fields. New `settings:read` (EDITOR+) and `settings:manage` (ADMIN) API token scopes back the tools, with matching options in the personal API token settings UI.

### Patch Changes

- [#398](https://github.com/emdash-cms/emdash/pull/398) [`31333dc`](https://github.com/emdash-cms/emdash/commit/31333dc593e2b9128113e4e923455209f11853fd) Thanks [@simnaut](https://github.com/simnaut)! - Adds pluggable auth provider system with AT Protocol as the first plugin-based provider. Refactors GitHub and Google OAuth from hardcoded buttons into the same `AuthProviderDescriptor` interface. All auth methods (passkey, AT Protocol, GitHub, Google) are equal options on the login page and setup wizard.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `taxonomies:manage` and `menus:manage` API token scopes for fine-grained control over taxonomy and menu mutations via MCP and REST. Existing tokens with `content:write` continue to work for those operations: `content:write` now implicitly grants `menus:manage` and `taxonomies:manage` so PATs issued before the split keep their effective permissions. The reverse implication does not hold — a token with only `menus:manage` cannot create or edit content.

## 0.7.0

### Patch Changes

- [#736](https://github.com/emdash-cms/emdash/pull/736) [`81fe93b`](https://github.com/emdash-cms/emdash/commit/81fe93bc675581ddd0161eaabbe7a3471ec76529) Thanks [@ascorbic](https://github.com/ascorbic)! - Restricts Subscriber-role access to draft, scheduled, and trashed content. Subscribers retain `content:read` for member-only published content but no longer see non-published items via the REST API or MCP server. Adds a new `content:read_drafts` permission (Contributor and above) that gates `/compare`, `/revisions`, `/trash`, `/preview-url`, and the corresponding MCP tools.

## 0.6.0

### Patch Changes

- [#552](https://github.com/emdash-cms/emdash/pull/552) [`f52154d`](https://github.com/emdash-cms/emdash/commit/f52154da8afb838b1af6deccf33b5a261257ec7c) Thanks [@masonjames](https://github.com/masonjames)! - Fixes passkey login failures so unregistered or invalid credentials return an authentication failure instead of an internal server error.

## 0.5.0

### Patch Changes

- [#542](https://github.com/emdash-cms/emdash/pull/542) [`64f90d1`](https://github.com/emdash-cms/emdash/commit/64f90d1957af646ca200b9d70e856fa72393f001) Thanks [@mohamedmostafa58](https://github.com/mohamedmostafa58)! - Fixes invite flow: corrects invite URL to point to admin UI page, adds InviteAcceptPage for passkey registration.

## 0.4.0

## 0.3.0

## 0.2.0

### Patch Changes

- [#452](https://github.com/emdash-cms/emdash/pull/452) [`1a93d51`](https://github.com/emdash-cms/emdash/commit/1a93d51777afaec239641e7587d6e32d8a590656) Thanks [@kamine81](https://github.com/kamine81)! - Fixes GitHub OAuth login failing with 403 on accounts where email is private. GitHub's API requires a `User-Agent` header and rejects requests without it.

## 0.1.1

### Patch Changes

- [#133](https://github.com/emdash-cms/emdash/pull/133) [`9269759`](https://github.com/emdash-cms/emdash/commit/9269759674bf254863f37d4cf1687fae56082063) Thanks [@kyjus25](https://github.com/kyjus25)! - Fix auth links and OAuth callbacks to use `/_emdash/api/auth/...` so emailed sign-in, signup, and invite URLs resolve correctly in EmDash.

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release
