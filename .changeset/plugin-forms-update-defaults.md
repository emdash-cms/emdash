---
"@emdash-cms/plugin-forms": patch
---

Fixes `forms/update` so that partial `settings` updates no longer reset other settings to their creation defaults.

Previously, sending only one setting — such as `notifyEmails` — caused `spamProtection`, `confirmationMessage`, `submitLabel`, and other defaulted fields to revert to their defaults, which could silently disable Turnstile spam protection. Update payloads now only change the fields they include.
