---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes WXR imports publishing password-protected WordPress posts for anyone to read on the imported site. The admin import and `emdash import wordpress` now bring in a post with a WordPress password as a draft, whatever its WordPress status, and list each one on the **Import Complete** screen and in the CLI output.

Imports through the EmDash Exporter plugin are unchanged: the exporter does not send post passwords, so a published, password-protected post still arrives published.

#### What should I do?

If you imported a WXR file before this release, or import through the EmDash Exporter, find the entries that WordPress marks as "Password protected" on its **Posts**, **Pages** and custom post type screens, and unpublish them in EmDash if they should stay private.
