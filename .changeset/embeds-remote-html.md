---
"@emdash-cms/plugin-embeds": patch
---

Updates Gist and Mastodon embed rendering for consistent remote-content handling. Gist blocks accept gist page URLs such as `https://gist.github.com/<user>/<id>`; other URL forms render nothing. Mastodon posts retain supported content and formatting after fetched markup is normalized before rendering.
