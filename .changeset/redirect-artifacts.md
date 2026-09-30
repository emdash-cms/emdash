---
"emdash": patch
---

Speeds up redirect matching on sites with many redirects. Public requests now load the enabled redirect rules in a single query and afterwards check one small row to see whether they changed, instead of reading the whole redirects table every 30 seconds in every Worker isolate. Redirect changes made in the admin, through the API, by automatic slug-change redirects, by seeding or by import take effect as before. A site that has just upgraded, or whose published redirect data is missing or damaged, keeps serving redirects from the redirects table while it rebuilds that data in the background.
