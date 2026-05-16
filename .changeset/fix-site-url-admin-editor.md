---
"emdash": patch
"@emdash-cms/admin": patch
---

Adds a Site URL field to admin General Settings that updates the `emdash:site_url` option, making the URL used for transactional emails (magic-link, invites, password resets) editable after the setup wizard. Fixes #989.

A new endpoint, `GET/POST /_emdash/api/settings/site-url`, gates the write on `settings:manage` and normalizes the submitted value to a bare origin (rejecting non-http(s) schemes and any value carrying a path, query string, or fragment). The pre-existing `site:url` setting in the Site Identity section (used for canonical links and sitemaps) is unchanged.
