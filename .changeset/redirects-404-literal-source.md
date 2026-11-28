---
"@emdash-cms/admin": patch
---

Fixes the **404 Errors** tab creating a pattern redirect from a logged path that contains brackets. "Mark as Gone (410)" on a row such as `/posts/[slug]` used to create a pattern rule that answered `410 Gone` for every post, and "Create redirect" prefilled the same pattern. Both actions now percent-encode the brackets (`/posts/%5Bslug%5D`), so the rule matches only the path that was logged. Patterns typed into the redirect form work as before.
