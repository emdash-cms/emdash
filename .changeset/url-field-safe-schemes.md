---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes stored cross-site scripting through `url` content fields. EmDash previously accepted `javascript:` and `data:` values, so a theme rendering `<a href={entry.data.website}>` could run an attacker's script on the site origin. A `url` field, including one inside a repeater or block, now accepts only these values:

- `http:` and `https:` URLs
- `mailto:` and `tel:` links
- site-relative paths such as `/about`, and fragments such as `#contact`

The REST API, MCP tools, site transfers, WordPress imports, and the admin editor reject any other value with a validation error. Seeds and plugin content updates also reject unsafe schemes and path forms that browsers resolve to another site, including `//example.com` and `/\\example.com`. The admin editor now accepts relative paths, fragments, `mailto:`, and `tel:` and keeps URL input left-to-right in every locale.

Existing entries are not changed. An unsafe stored value is still returned by queries, and saving or duplicating that entry fails until the field is corrected. `sanitizeHref()` and `isSafeHref()` now reject unsafe protocol-relative, backslash-prefixed, and control-character forms when rendering older content.
