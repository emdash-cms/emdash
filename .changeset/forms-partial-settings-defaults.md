---
"@emdash-cms/plugin-forms": patch
---

Updating one form setting no longer resets the others. A partial `forms/update` previously filled in schema defaults for every setting the caller left out, so changing a notification address also reset the form's confirmation message, submit label, digest options, retention and — most seriously — its spam protection, silently turning off Cloudflare Turnstile.
