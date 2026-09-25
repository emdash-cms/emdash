---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/auth": minor
---

Localizes invite, magic-link, and account-recovery emails: they now follow the site locale (falling back to the requesting user's admin language) instead of always being sent in English. Email HTML sets `lang` and `dir` on the root element, so right-to-left languages render correctly. A non-canonical site locale (`pt-br`) is normalized to its catalog (`pt-BR`); an unsupported value falls back to the requesting user's admin language.

`@emdash-cms/auth`'s invite and magic-link builders (`buildInviteEmail`, `buildMagicLinkEmail`, now exported) accept optional injected copy and locale via new `emailStrings`/`emailLocale` config options (`InviteEmailStrings`/`MagicLinkEmailStrings`). `@emdash-cms/admin/locales` exports the copy resolvers `getInviteEmailStrings`/`getMagicLinkEmailStrings` and the BCP 47 matcher `matchLocale`.
