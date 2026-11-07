---
title: Dynamic social links with identity verification
type: feature-plan
status: proposed
authors:
  - Evgenii (@Evgenii-Zinner)
discussion: https://github.com/emdash-cms/emdash/discussions/4621
created: 2026-11-07
---

# Dynamic social links with identity verification

## Problem and user case

EmDash previously stored social media profiles in a static 6-key map (`twitter`, `github`, `facebook`, `instagram`, `linkedin`, `youtube`) containing usernames or URLs.

This static configuration had several limitations:

1. It could not represent modern social and decentralized profiles (e.g. Mastodon, Bluesky, Threads, YouTube channels, custom personal websites, or multiple accounts on the same platform).
2. It lacked IndieWeb identity verification: publishers could not emit `<link rel="me">` tags for profiles they own.
3. It did not automatically connect site profiles to Schema.org `sameAs` structured data on the `WebSite` entity.

Issue/Discussion [#4621](https://github.com/emdash-cms/emdash/discussions/4621) requests replacing the static handles with dynamic social profile links supporting `rel="me"` identity verification and search entity disambiguation.

## Proposed behavior

1. **Dynamic Social Links**:
   Site owners manage a dynamic list of social profiles in **Settings > Social**. Each item has:
   - `id`: unique string identifier;
   - `platform`: optional platform key (e.g. `"github"`, `"mastodon"`);
   - `label`: display title (e.g. `"GitHub"`, `"Mastodon"`, `"Personal Blog"`);
   - `url`: absolute http(s) URL;
   - `relMe`: boolean indicating whether identity verification is enabled.

2. **IndieWeb Verification (`rel="me"`)**:
   `<EmDashHead>` scans `siteSettings.socialLinks` and emits `<link rel="me" href="...">` for each profile where `relMe === true`.

3. **Structured Data (`sameAs`)**:
   `buildWebSiteJsonLd` attaches an array of URLs for verified profiles (`relMe === true`) to the root `WebSite` entity.

4. **Bidirectional Backward Compatibility**:
   - For sites upgrading from legacy settings, existing `site:social` handles are converted to absolute URLs per platform (`relMe: false` by default so no unverified claims or broken links are emitted).
   - On write, `site:socialLinks` is the single source of truth. The legacy 6-platform `site:social` map is kept synchronized by deriving usernames/URLs from `socialLinks`, ensuring existing themes (like the portfolio template) continue to work without doubled URLs.
   - When legacy tools (older clients, scripts, or legacy MCP payloads) patch `site:social`, the patch is non-destructively merged into `socialLinks` without wiping custom links, custom labels, or unverified flags.

## Goals

- Allow site owners to add, edit, and remove arbitrary social and web profiles.
- Support IndieWeb `rel="me"` verification links in `<head>`.
- Provide search engines with unambiguous identity links via Schema.org `sameAs` on the `WebSite` entity.
- Maintain full backwards compatibility for themes and code expecting `settings.social`.
- Enforce size limits and strict URL validation to protect the public head payload.

## Non-goals

- Author-level / byline social links: byline structured data disambiguation is a separate domain model concern.
- Adding third-party OAuth or verification crawlers: verification is decentralized via reciprocal `rel="me"` links.

## Interfaces and compatibility

- **TypeScript types**:
  - `SiteSettings.socialLinks?: SocialLink[]` added.
  - `SiteSettings.social` preserves its static 6-key shape (`twitter`, `github`, `facebook`, `instagram`, `linkedin`, `youtube`) without index signatures, preventing breaking changes in existing themes.
- **REST & MCP API**:
  - `socialLinks` accepted in `settingsUpdateBody` and `settings_update` MCP tool.
  - Validated with Zod: array capped at 50 links, URL max 2048 characters, label max 100 characters.
- **Site Transfer**:
  - `"site:socialLinks"` added to `PORTABLE_SETTING_NAMES`.

## Errors and edge cases

- Handles stored in legacy settings (`@user` or `user`) are converted to platform-specific canonical URLs on upgrade. Values that cannot form valid http(s) URLs are excluded from `socialLinks`.
- Empty or partially filled rows in the admin UI: completely blank rows are pruned before submit; partially filled rows surface field-level validation errors.
- Links missing an `id` receive a server-generated unique ID to prevent React key or DOM ID collisions.

## Verification

- Unit tests for handle-to-URL conversion and URL-to-handle extraction for all supported legacy platforms.
- Tests verifying non-destructive merging when legacy `social` is updated.
- Tests verifying `<link rel="me">` and `sameAs` emission only for verified http(s) URLs.
- Admin browser tests covering add/edit/delete, empty row cleanup, and validation errors.
- TypeScript verification on `emdash` and `templates/portfolio` (`typecheck:demos`).
