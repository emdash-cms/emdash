---
"emdash": patch
---

Fixes the Categories, Tags, Recent Posts and Archives widgets showing visitors the default language on translated pages. They now list the terms, posts and months of the page's own locale, as signed-in editors already saw, and link under that locale, such as `/en/category/news` and `/en/archives/2025/01`. A Recent Posts `urlTemplate` gets the locale prefix too, unless the template already starts with it.
