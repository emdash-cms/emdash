---
"@emdash-cms/admin": patch
---

Fix unreadable "Published" status badge in dark mode. The content editor rendered the published badge as `<Badge variant="primary" className="text-white">`, which produces white text on a light inverted background in dark mode. Use the semantic `variant="success"` (green) instead, which is dark-mode aware and matches the green "published" badge used on the content overview list.
