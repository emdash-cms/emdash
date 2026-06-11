---
"emdash": patch
---

Pages render with fewer database round trips:

- Tag and category archive pages load faster — `getTerm()` fetches its details in parallel instead of one query at a time.
- Pages with several menus (header, footer, …) no longer repeat the same lookup for each menu.
- Entries fetched with `getEmDashEntry`/`getEmDashCollection` already include their taxonomy terms — you can now read `entry.data.terms?.tag` directly (it's typed in your generated `emdash-env.d.ts`) instead of making a separate `getEntryTerms()` call. The bundled templates have been updated to do this.
