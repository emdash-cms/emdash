---
"emdash": patch
---

Fixes site SEO settings `googleVerification` and `bingVerification` not being emitted into `<head>`. The fields were stored in the database and editable in the admin UI but were never rendered as `<meta name="google-site-verification">` or `<meta name="msvalidate.01">` tags, making meta-tag verification with Google Search Console and Bing Webmaster Tools impossible. EmDashHead now loads site SEO settings and renders these tags on every page.
