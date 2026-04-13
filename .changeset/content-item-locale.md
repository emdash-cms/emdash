---
"emdash": minor
---

Adds `locale` to the `ContentItem` type returned by the plugin content access API. Follow-up to #536 — plugins that build i18n URLs from content records need the locale to pick the right URL prefix, otherwise multilingual content is emitted at default-locale URLs.
