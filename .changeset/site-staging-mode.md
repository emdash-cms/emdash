---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds a staging mode that keeps a site out of search engines until it goes live. Sites created through setup, whether in the setup wizard or by a script that calls the setup API, start in staging:

- Pages that render `<EmDashHead>` get a `noindex, nofollow` robots tag, which overrides SEO panel and plugin robots values. Templates without `<EmDashHead>` don't get the tag.
- `/robots.txt` keeps its usual content so crawlers can read the tag, and isn't cached while the site is in staging.
- The admin header shows a **Staging** badge.

To go live, an administrator selects **Go live** in **Settings > General > Site Status**, sends `{ "staging": false }` to the settings API, or uses the MCP `settings_update` tool. **Switch back to staging** hides the site again. Staging is visibility only: visitors can still open every page.

Existing sites are not affected: a site without the setting is live. Site transfer and `emdash export-seed` don't copy the staging status.
