---
"emdash": patch
---

Fixes hierarchical taxonomy terms losing their parent in translated locales. A child term now stores its parent's translation group instead of a locale-bound row id, so translating a parent automatically re-nests its existing children in every locale instead of flattening them to the root. A forward-only migration backfills existing parent links.
