---
"emdash": patch
"@emdash-cms/admin": patch
---

Reduces the memory needed to build EmDash from source. The admin route now imports the admin app through a narrower internal entry point, so type generation no longer loads the full admin component and icon type graph.
