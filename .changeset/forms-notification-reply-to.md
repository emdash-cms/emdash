---
"@emdash-cms/plugin-forms": patch
---

Fixes form notification emails so that replying to one reaches the person who submitted the form. Notifications now set Reply-To to the address entered in the form's email field; before, a reply went to the site's sender address. Forms without an email field, or submissions that leave it empty, send notifications without a Reply-To, as before. The site's email provider plugin must deliver `replyTo` (see the `email:deliver` hook).
