---
"@emdash-cms/admin": patch
---

Formats every date and time in the admin in the admin's own language, and keeps them whole in right-to-left layouts.

`formatRelativeTime` returned hardcoded English ("3 mins ago"), so an admin in any other language read it in English — and in Arabic, Farsi or Hebrew the leading number rendered at the wrong end of the phrase. It now writes the phrase with `Intl.RelativeTimeFormat` in the active locale, which is what the same helper in the passkey list already did; that copy is gone.

Dates were formatted with `toLocaleDateString()` and no locale, which follows the _browser's_ language rather than the one chosen in the admin, so a Hebrew admin in an English browser printed English months. Every call site now passes the admin's locale through a shared `formatDate`.

Formatted dates are also bidi-isolated: a date carries digits and punctuation whose direction the bidirectional algorithm takes from the text around it, so "22 בספט׳ 2026, 22:48" rendered with its comma against the wrong number. They are wrapped in `<bdi>` where they are rendered on their own, and in Unicode isolates (`isolate`) where they are interpolated into a translated sentence.

The shared `formatDate` defaults to the locale's own date format, so no call site changes how it looks. The one exception is the comment detail panel, which showed `9/22/2026 10:48:00 PM` and now shows the date and time as one medium/short pair.
