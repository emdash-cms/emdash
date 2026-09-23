---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes stored cross-site scripting through `url` content fields. EmDash previously accepted `javascript:` and `data:` values, so a theme rendering `<a href={entry.data.website}>` could run an attacker's script on the site origin. A `url` field, including one inside a repeater, now accepts only these values:

- `http:` and `https:` URLs
- `mailto:` and `tel:` links
- site-relative paths such as `/about`, and fragments such as `#contact`

The REST API, MCP tools, WordPress imports, and the admin editor reject any other value with a validation error. Seeds and plugin content updates reject other schemes too. The admin editor now also accepts relative paths, fragments, `mailto:`, and `tel:`.

Existing entries are not changed. A value stored with another scheme is still returned by queries, and saving or duplicating that entry fails until the field is corrected. If your site has older content, pass `url` values through `sanitizeHref()` from `emdash` when rendering them.
