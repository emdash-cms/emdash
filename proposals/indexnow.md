---
title: Notify search engines through IndexNow
type: rfc
status: proposed
authors:
  - Kevin Kyburz (@swissky)
  - Evgenii Zinner (@Evgenii-Zinner)
champion: Kevin Kyburz (@swissky)
sponsor: Kevin Kyburz (@swissky)
discussions: []
created: 2026-11-14
---

# Notify search engines through IndexNow

## Summary

Sites can enable IndexNow in the SEO settings. Core then tells participating search engines about the canonical URLs of entries that are published, updated, unpublished, trashed, restored or renamed, without delaying the editor's request. IndexNow is off by default.

This RFC builds on the SEO foundation RFC (design [#4765](https://github.com/emdash-cms/emdash/pull/4765)): it submits the URLs that `resolveEntryUrl` returns and adds a section to the SEO settings screen. It reuses both instead of defining them again.

## Problem and user case

Search engines learn about changed entries only when they crawl the sitemap or the page again, which can take days on new or fast-moving sites ([issue #4529](https://github.com/emdash-cms/emdash/issues/4529)). IndexNow lets a site submit changed URLs in one HTTP request ([IndexNow documentation](https://www.indexnow.org/documentation)). The protocol's [list of participating engines](https://www.indexnow.org/searchengines.json) includes Bing, Yandex, Naver, Seznam, Yep, Internet Archive and Amazonbot. Google is not on the list, so IndexNow has no effect on Google Search.

## Example

An administrator enables IndexNow. Core generates the key `3f9c1e7a5b2d4c8e9a0b1c2d3e4f5a6b`, serves it at `https://example.com/3f9c1e7a5b2d4c8e9a0b1c2d3e4f5a6b.txt`, and shows the last submission in the SEO settings. An editor changes the slug of a published post from `launch` to `we-launched`. After the response, core posts:

```json
{
	"host": "example.com",
	"key": "3f9c1e7a5b2d4c8e9a0b1c2d3e4f5a6b",
	"keyLocation": "https://example.com/3f9c1e7a5b2d4c8e9a0b1c2d3e4f5a6b.txt",
	"urlList": ["https://example.com/blog/we-launched/", "https://example.com/blog/launch/"]
}
```

## Goals

- Sites notify IndexNow when public URLs change, without delaying the editor's save or publish.
- Only canonical URLs on the site's own host are submitted.
- Administrators see whether submissions work and can recover from key errors in the admin.

## Non-goals

- Google-specific notification, which Google doesn't offer for general content.
- Submitting URLs of custom Astro routes or other pages that aren't entries.
- A pluggable notification API for other services.

## Detailed design

- **Key.** An administrator enables IndexNow in the SEO settings. Core then generates a key of 32 hexadecimal characters (the protocol allows 8 to 128) and stores it in `site:indexnow`, which is target-local: site transfer doesn't copy it, so a cloned site gets its own key. A **Regenerate key** action in the SEO settings replaces the key and resumes submissions that stopped on a key error.
- **Key file.** Core serves the key at `/{key}.txt` at the root of the host as UTF-8 plain text, the location the protocol recommends, and also sends that URL as `keyLocation`. The route matches only the current key, so requests for any other `.txt` path fall through to the site's own routes.
- **Triggers.** Publishing (including scheduled publishing), publishing a new revision of a published entry, unpublishing, moving a published entry to trash, restoring a published entry, and slug changes of published entries submit the affected canonical URLs, including the old URL after a slug change. Saving a draft submits nothing. Core hooks into the same points that fire `content:afterPublish`, `content:afterUnpublish`, `content:afterDelete` and `content:afterRestore`.
- **URLs.** Each URL comes from `resolveEntryUrl`. An entry whose SEO canonical points at another URL, or that has `noindex`, is not submitted.
- **Delivery.** Submissions run in `after()`, so they never delay the editor's request. Within one request, URLs are batched into one POST; the protocol allows up to 10,000 URLs per request. Core posts to `https://api.indexnow.org/indexnow`, which shares submissions with all participating engines.
- **Scope.** Core submits only URLs on the configured `site:url` host. Without `site:url`, or while the site is in staging, or when the host is `localhost` or a private address, IndexNow stays inactive and the settings screen says why.
- **Status.** Core stores the time and HTTP status of the last submission in `emdash:indexnow_status` and shows it in the SEO settings. A manual **Submit this URL** action in the editor's SEO panel submits the current entry.

All new admin strings go through Lingui, layouts use logical Tailwind classes, and the settings section is tested in Arabic.

## Compatibility and migration

IndexNow is off by default, so upgrading changes nothing until an administrator enables it. `site:indexnow` and `emdash:indexnow_status` are new options, and older versions ignore them. No migration is needed. Disabling IndexNow stops submissions and the key route returns 404.

## Security and privacy

- **Outbound requests.** Core posts only to `api.indexnow.org`, and only canonical URLs on the configured site host, so editors can't make the server request arbitrary hosts. A failed submission logs the HTTP status, never the key.
- **Authorization.** Enabling IndexNow and regenerating the key require `settings:manage`. A manual submission requires permission to publish the entry.
- **Keys.** The key is public by design, since the key file proves control of the host. It is excluded from site transfer so two sites don't share a key.
- **Privacy.** IndexNow sends public URLs to a third-party service. Staging sites send nothing, so search engines don't learn unreleased URLs from them.

## Performance

Submissions run after the response in `after()`, so editor requests keep their latency. The key route reads the cached site settings, and logged-out page renders run no additional query.

## Failure handling

200 and 202 count as success. On 429 core reads `Retry-After`, stores the end of the wait in `emdash:indexnow_status`, keeps the URLs and sends them with the first submission after the wait ([IndexNow FAQ](https://www.indexnow.org/faq)). On 403 (key not valid) and 422 (URLs not on the host, or a key the protocol doesn't accept) automatic submissions stop and the settings screen asks the administrator to check the key file or regenerate the key. Other errors are logged with the prefix `[indexnow]` and recorded in `emdash:indexnow_status`. No failure affects the save or publish that triggered it.

## Verification

- Tests with a stubbed `fetch` for batching, the old URL after a slug change, skipped hosts, staging, `noindex` and canonical overrides, 403, 422, and 429 with `Retry-After`.
- A route test that only the current key is served.
- One manual submission from the demo deployment, confirmed in Bing Webmaster Tools.
- Playwright tests for enabling IndexNow, regenerating the key and the status display, including the Arabic layout, with screenshots in the UI PR.

## Rollout and implementation

Kevin Kyburz (@swissky) and Evgenii Zinner (@Evgenii-Zinner) implement it in one PR after Phase 2 of the SEO foundation RFC provides `resolveEntryUrl`. No feature flag is needed, because IndexNow is off by default.

## Alternatives

- **A first-party plugin.** A plugin can't serve a file at the root of the host or read the canonical decisions of core. Keeping IndexNow next to `resolveEntryUrl` avoids a second URL builder.
- **Pinging each engine.** `api.indexnow.org` shares submissions with all participating engines, so one request covers them.
- **Key under `/.well-known/` or `/_emdash/`.** A key file outside the root only authorizes URLs below its path, so it couldn't cover the whole site.

## Drawbacks

- IndexNow sends data to a third-party service. It is off by default and enabled per site.
- A site whose CDN or firewall blocks the key file gets 422 responses until an administrator fixes it.

## Open questions

None at the moment.
