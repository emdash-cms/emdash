---
"@emdash-cms/plugin-forms": patch
---

Fixes form notification emails so that replying to one reaches the person who submitted the form. Instant notifications now set Reply-To to the address entered in the form's email field; before, a reply went to the site's sender address. The daily digest is unchanged. Reply-To is only set when the address is a plain, valid email: forms without an email field, submissions that leave it empty, or addresses like `"Name"<someone@example.com>` send notifications without a Reply-To, as before. On sites that set `replyTo` on the Cloudflare email provider, replies to these notifications now go to the visitor instead of that address. The site's email provider plugin must deliver `replyTo` (see the `email:deliver` hook).
