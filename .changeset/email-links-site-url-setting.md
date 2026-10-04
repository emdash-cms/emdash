---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes email links pointing to the address a site was set up on after it moved to a new domain. Sign-in, invitation, self-signup, recovery, and comment notification emails now use the **Site URL** from **Settings > General** when `siteUrl`, `EMDASH_SITE_URL`, or `SITE_URL` is not configured, and fall back to the setup address when the field is empty. Only the origin of the **Site URL** is used, and it must use `https://` unless the host is a loopback address. A configured `siteUrl` still takes precedence. `emdash export-seed` no longer copies the **Site URL** into the seed.

If you don't configure `siteUrl` and the **Site URL** field holds an address that doesn't serve this site's admin, for example an old domain, links in these emails point there after upgrading. Check the field before upgrading; clearing it restores the previous behavior. Seeds that set `settings.url`, including seeds exported by earlier versions, still fill in the **Site URL**, so remove `url` from a seed copied from another site before using it.
