---
"emdash": patch
---

Fixes `EmDashClient.terms()` returning `{ terms }` instead of `{ items }`, which caused `page.items` to be `undefined` for any caller that iterated the result. The API handler returns `{ terms: TermWithCount[] }` but the client was typed and advertised as `ListResult<Term>` — the key name mismatch is now mapped correctly.
